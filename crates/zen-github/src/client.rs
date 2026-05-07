//! `gh`-CLI-backed GitHub client. Every method shells out via [`zen_shell`].

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use zen_shell::{ShellError, ShellExecutor};

use crate::call_log::{CallLog, GhCall};
use crate::error::{GhError, GhResult};
use crate::models::auth::AuthStatus;
use crate::models::diff::{
    split_git_diff, DiffSide, DiffSource, FileDiff, FileStatus, PrDiff,
};
use crate::models::issue_comment::IssueComment;
use crate::models::pull_request::{
    EnrichedPullRequest, PrDetail, PrRef, PullRequest, ReviewEvent,
};
use crate::models::review_comment::ReviewComment;

/// Default `--json` field list reused by every `gh search prs` call so the
/// resulting [`PullRequest`] always has the same shape.
const SEARCH_JSON_FIELDS: &str =
    "number,title,url,state,createdAt,updatedAt,isDraft,author,repository";

/// Cheap-to-clone (`Arc`) handle wrapping a [`ShellExecutor`] and a rolling
/// call log. Mirror of the Swift `GitHubService` actor.
#[derive(Debug, Clone)]
pub struct GhClient {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    exec: ShellExecutor,
    log: CallLog,
}

impl GhClient {
    /// Build a client with the standard PATH-augmented executor.
    pub fn new() -> Self {
        Self::with_executor(ShellExecutor::new().with_timeout(Duration::from_secs(60)))
    }

    /// Build a client with a caller-provided executor (handy in tests).
    pub fn with_executor(exec: ShellExecutor) -> Self {
        Self {
            inner: Arc::new(Inner {
                exec,
                log: CallLog::default(),
            }),
        }
    }

    /// Snapshot of the rolling call log — feeds the API Stats tab.
    pub fn call_log_snapshot(&self) -> Vec<GhCall> {
        self.inner.log.snapshot()
    }

    /// `(total, session, recent_calls)` triple matching the Swift
    /// `GitHubService.getStats()`.
    pub fn call_log_stats(&self) -> (u64, u64, Vec<GhCall>) {
        self.inner.log.stats()
    }

    /// Reset the per-session counter without dropping the log.
    pub fn reset_session(&self) {
        self.inner.log.reset_session();
    }

    /// Run `gh <args…>`, recording the call in the rolling log. Returns
    /// stdout (whitespace preserved).
    async fn gh(&self, label: &str, args: &[&str]) -> GhResult<String> {
        let start = Instant::now();
        let res = self.inner.exec.run("gh", args).await;
        let success = res.is_ok();
        self.inner
            .log
            .record(GhCall::new(label, start.elapsed(), success));
        match res {
            Ok(out) => Ok(out.stdout),
            Err(e) => Err(GhError::Shell(e)),
        }
    }

    /// Run `gh <args…>` with retry/backoff. Auth errors short-circuit
    /// (no point retrying a 401/403), missing CLI short-circuits, timeouts
    /// and transient failures retry up to `max_attempts`.
    async fn gh_retry(&self, label: &str, args: &[&str]) -> GhResult<String> {
        const MAX_ATTEMPTS: u32 = 3;
        let mut delay = Duration::from_secs(1);
        let mut last_err: Option<GhError> = None;

        for attempt in 1..=MAX_ATTEMPTS {
            match self.gh(label, args).await {
                Ok(out) => return Ok(out),
                Err(GhError::Shell(ShellError::CommandNotFound(_))) => {
                    return Err(last_err.unwrap_or_else(|| {
                        GhError::Shell(ShellError::CommandNotFound("gh".into()))
                    }));
                }
                Err(GhError::Shell(ShellError::CommandFailed { ref output, .. }))
                    if (output.contains("401") || output.contains("403"))
                        && !output.contains("rate limit") =>
                {
                    return Err(GhError::Shell(ShellError::CommandFailed {
                        program: "gh".into(),
                        exit_code: -1,
                        output: output.clone(),
                    }));
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(delay).await;
                        delay *= 2;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            GhError::Unexpected("retry loop exited with no error".into())
        }))
    }

    // ─── Identity ────────────────────────────────────────────────────────

    /// Return the current user's login (`gh api user --jq .login`).
    pub async fn whoami(&self) -> GhResult<String> {
        let out = self
            .gh_retry("api user --jq .login", &["api", "user", "--jq", ".login"])
            .await?;
        Ok(out.trim().to_string())
    }

    /// `gh --version` (returns the first line of stdout).
    pub async fn version(&self) -> GhResult<String> {
        let out = self.gh("--version", &["--version"]).await?;
        Ok(out.lines().next().unwrap_or("").trim().to_string())
    }

    /// Combined `gh --version` + `gh auth status` health-check.
    pub async fn auth_status(&self) -> GhResult<AuthStatus> {
        let version = match self.version().await {
            Ok(v) => Some(v),
            Err(GhError::Shell(ShellError::CommandNotFound(_))) => {
                return Ok(AuthStatus {
                    installed: false,
                    ..AuthStatus::unknown()
                });
            }
            Err(e) => return Err(e),
        };

        // `gh auth status` prints to stderr and exits non-zero when not
        // authenticated; treat both stdout and stderr as informational.
        let raw = match self.gh("auth status", &["auth", "status"]).await {
            Ok(out) => out,
            Err(GhError::Shell(ShellError::CommandFailed { output, .. })) => output,
            Err(e) => return Err(e),
        };

        let lower = raw.to_ascii_lowercase();
        let authenticated = lower.contains("logged in to") || lower.contains("✓ logged in");

        // Best-effort parse of "Logged in to {host} as {login}" from gh's output.
        let mut login = None;
        let mut host = None;
        for line in raw.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed
                .strip_prefix("✓ Logged in to ")
                .or_else(|| trimmed.strip_prefix("Logged in to "))
            {
                if let Some((h, after)) = rest.split_once(" as ") {
                    host = Some(h.trim().to_string());
                    let login_str = after
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_matches(|c: char| c == ',' || c == '.');
                    if !login_str.is_empty() {
                        login = Some(login_str.to_string());
                    }
                }
            }
        }

        Ok(AuthStatus {
            installed: true,
            version,
            authenticated,
            login,
            host,
            raw,
        })
    }

    // ─── PR searches ─────────────────────────────────────────────────────

    /// Open PRs the current user authored.
    pub async fn search_mine(&self) -> GhResult<Vec<PullRequest>> {
        self.search_prs(
            "search prs --author @me",
            &[
                "search",
                "prs",
                "--author",
                "@me",
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                SEARCH_JSON_FIELDS,
            ],
        )
        .await
    }

    /// Open PRs that have requested the current user as a reviewer.
    pub async fn search_to_review(&self) -> GhResult<Vec<PullRequest>> {
        self.search_prs(
            "search prs --review-requested @me",
            &[
                "search",
                "prs",
                "--review-requested",
                "@me",
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                SEARCH_JSON_FIELDS,
            ],
        )
        .await
    }

    /// Open PRs the current user has reviewed.
    pub async fn search_reviewed(&self) -> GhResult<Vec<PullRequest>> {
        self.search_prs(
            "search prs --reviewed-by @me",
            &[
                "search",
                "prs",
                "--reviewed-by",
                "@me",
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                SEARCH_JSON_FIELDS,
            ],
        )
        .await
    }

    async fn search_prs(&self, label: &str, args: &[&str]) -> GhResult<Vec<PullRequest>> {
        let json = self.gh_retry(label, args).await?;
        if json.trim().is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str::<Vec<PullRequest>>(&json)
            .map_err(|e| GhError::decode(label.to_string(), e))
    }

    // ─── PR detail (GraphQL batch) ───────────────────────────────────────

    /// Fetch [`PrDetail`] for one PR. Convenience over `batch_pr_details`.
    pub async fn pr_detail(&self, pr: &PrRef) -> GhResult<PrDetail> {
        let mut map = self.batch_pr_details(&pr.owner, &pr.repo, &[pr.number]).await?;
        map.remove(&pr.number)
            .ok_or_else(|| GhError::Unexpected(format!(
                "no PR detail returned for {}/{}#{}",
                pr.owner, pr.repo, pr.number
            )))
    }

    /// Batched detail fetch — assembles a single GraphQL query with one
    /// aliased field per PR (matches the Swift implementation).
    pub async fn batch_pr_details(
        &self,
        owner: &str,
        repo: &str,
        numbers: &[u64],
    ) -> GhResult<std::collections::HashMap<u64, PrDetail>> {
        let mut out = std::collections::HashMap::new();
        if numbers.is_empty() {
            return Ok(out);
        }

        let pr_blocks: Vec<String> = numbers
            .iter()
            .map(|n| format!(
                "    pr{n}: pullRequest(number: {n}) {{\n{PR_FRAGMENT}\n    }}"
            ))
            .collect();

        let query = format!(
            "query {{\n  repository(owner: \"{owner}\", name: \"{repo}\") {{\n{}\n  }}\n}}",
            pr_blocks.join("\n")
        );

        let label = format!("graphql batch {owner}/{repo} ({} PRs)", numbers.len());
        let stdout = self
            .gh_retry(&label, &["api", "graphql", "-f", &format!("query={query}")])
            .await?;

        let parsed: Value = serde_json::from_str(&stdout)
            .map_err(|e| GhError::decode(label.clone(), e))?;

        if let Some(errors) = parsed.get("errors") {
            if let Some(first) = errors.as_array().and_then(|a| a.first()) {
                let msg = first
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown GraphQL error");
                return Err(GhError::Graphql(msg.to_string()));
            }
        }

        let repo_obj = parsed
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.as_object())
            .ok_or_else(|| GhError::Unexpected(format!("missing data.repository in {label}")))?;

        for (key, val) in repo_obj {
            if let Some(num_str) = key.strip_prefix("pr") {
                if let Ok(num) = num_str.parse::<u64>() {
                    match serde_json::from_value::<PrDetail>(val.clone()) {
                        Ok(detail) => {
                            out.insert(num, detail);
                        }
                        Err(e) => {
                            tracing::warn!(pr = num, error = %e, "failed to decode PR detail");
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    // ─── PR enrichment ───────────────────────────────────────────────────

    /// Take a list of [`PullRequest`]s and merge in their [`PrDetail`]s
    /// (batched per-repo). Mirrors the `enrich(...)` step run by Swift's
    /// `PRListViewModel.refresh()`.
    pub async fn enrich(
        &self,
        prs: Vec<PullRequest>,
    ) -> GhResult<Vec<EnrichedPullRequest>> {
        use std::collections::HashMap;

        let mut by_repo: HashMap<String, Vec<u64>> = HashMap::new();
        for pr in &prs {
            by_repo
                .entry(pr.repository.name_with_owner.clone())
                .or_default()
                .push(pr.number);
        }

        let mut detail_map: HashMap<String, HashMap<u64, PrDetail>> = HashMap::new();
        for (repo, numbers) in by_repo {
            let (owner, name) = match repo.split_once('/') {
                Some(parts) => parts,
                None => continue,
            };
            match self.batch_pr_details(owner, name, &numbers).await {
                Ok(m) => {
                    detail_map.insert(repo, m);
                }
                Err(e) => {
                    tracing::warn!(%repo, error = %e, "batch_pr_details failed; continuing with empty details");
                    detail_map.insert(repo, HashMap::new());
                }
            }
        }

        let mut enriched = Vec::with_capacity(prs.len());
        for pr in prs {
            let detail = detail_map
                .get_mut(&pr.repository.name_with_owner)
                .and_then(|m| m.remove(&pr.number));

            let (review_decision, reviews, requested_reviewers, merged_by, merged_at) =
                match detail.as_ref() {
                    Some(d) => {
                        let reviews = d
                            .reviews
                            .as_ref()
                            .map(|n| n.nodes.clone())
                            .unwrap_or_default();
                        let requested = d
                            .review_requests
                            .as_ref()
                            .map(|n| {
                                n.nodes
                                    .iter()
                                    .filter_map(|node| {
                                        node.requested_reviewer
                                            .as_ref()
                                            .map(|r| r.display_name().to_string())
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        (
                            d.review_decision,
                            reviews,
                            requested,
                            d.merged_by.as_ref().map(|m| m.login.clone()),
                            d.merged_at,
                        )
                    }
                    None => (None, Vec::new(), Vec::new(), None, None),
                };

            enriched.push(EnrichedPullRequest {
                pr,
                review_decision,
                reviews,
                requested_reviewers,
                merged_by,
                merged_at,
                detail,
            });
        }
        Ok(enriched)
    }

    // ─── PR actions ──────────────────────────────────────────────────────

    /// Submit a review (`APPROVE | REQUEST_CHANGES | COMMENT`).
    pub async fn submit_review(
        &self,
        pr: &PrRef,
        event: ReviewEvent,
        body: Option<&str>,
    ) -> GhResult<()> {
        let path = format!("repos/{}/{}/pulls/{}/reviews", pr.owner, pr.repo, pr.number);
        let mut args: Vec<String> = vec![
            "api".into(),
            path,
            "-X".into(),
            "POST".into(),
            "-f".into(),
            format!("event={}", event.as_wire()),
        ];
        if let Some(text) = body {
            if !text.is_empty() {
                args.push("-f".into());
                args.push(format!("body={text}"));
            }
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let label = format!(
            "review {} {}/{}#{}",
            event.as_wire(),
            pr.owner,
            pr.repo,
            pr.number
        );
        self.gh_retry(&label, &arg_refs).await?;
        Ok(())
    }

    // ─── Repos / orgs / commits / diffs ─────────────────────────────────

    /// `gh repo list --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner'`.
    pub async fn list_repos(&self) -> GhResult<Vec<String>> {
        let out = self
            .gh_retry(
                "repo list",
                &[
                    "repo",
                    "list",
                    "--limit",
                    "1000",
                    "--json",
                    "nameWithOwner",
                    "--jq",
                    ".[].nameWithOwner",
                ],
            )
            .await?;
        Ok(out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    /// `gh repo list <org>` — same JSON shape as [`list_repos`].
    pub async fn list_org_repos(&self, org: &str) -> GhResult<Vec<String>> {
        let label = format!("repo list {org}");
        let out = self
            .gh_retry(
                &label,
                &[
                    "repo",
                    "list",
                    org,
                    "--limit",
                    "1000",
                    "--json",
                    "nameWithOwner",
                    "--jq",
                    ".[].nameWithOwner",
                ],
            )
            .await?;
        Ok(out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    /// `gh org list` — newline-separated org names.
    pub async fn list_orgs(&self) -> GhResult<Vec<String>> {
        let out = self.gh("org list", &["org", "list"]).await?;
        Ok(out
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    /// `gh api repos/{owner}/{repo}/commits` filtered by author + date range.
    /// Returns the raw JSON value (caller decides how to parse).
    pub async fn list_repo_commits(
        &self,
        repo: &str,
        author: &str,
        since_iso: &str,
        until_iso: &str,
    ) -> GhResult<serde_json::Value> {
        let path = format!("repos/{repo}/commits");
        let label = format!("commits {repo}");
        let since = format!("since={since_iso}");
        let until = format!("until={until_iso}");
        let author_arg = format!("author={author}");
        let stdout = self
            .gh_retry(
                &label,
                &[
                    "api",
                    &path,
                    "-X",
                    "GET",
                    "-f",
                    &author_arg,
                    "-f",
                    &since,
                    "-f",
                    &until,
                    "--paginate",
                ],
            )
            .await?;
        if stdout.trim().is_empty() {
            return Ok(serde_json::Value::Array(vec![]));
        }
        serde_json::from_str(&stdout).map_err(|e| GhError::decode(label, e))
    }

    /// `gh api repos/{owner}/{repo}/commits/{sha}` with `Accept: application/vnd.github.diff`.
    pub async fn commit_diff(&self, repo: &str, sha: &str) -> GhResult<String> {
        let path = format!("repos/{repo}/commits/{sha}");
        let label = format!("diff {repo}@{sha}");
        let out = self
            .gh_retry(
                &label,
                &[
                    "api",
                    &path,
                    "-H",
                    "Accept: application/vnd.github.diff",
                ],
            )
            .await?;
        Ok(out)
    }

    // ─── PR diff (Files Changed view) ────────────────────────────────────

    /// Fetch the per-file diff for a PR.
    ///
    /// When `local_path` is supplied and points at a working git clone,
    /// we **fetch** the base + head refs from `origin` and run
    /// `git diff base...head` against the freshly fetched SHAs — same
    /// approach VS Code's GitHub PR extension uses, so the diff
    /// matches what the user would see on github.com even if their
    /// local branch is out-of-date.
    ///
    /// When `local_path` is `None`, falls back to the GitHub REST
    /// `/repos/{owner}/{repo}/pulls/{n}/files` endpoint (paginated).
    /// REST returns per-file `patch` strings without the `diff --git`
    /// header — we rebuild a synthetic header so the frontend can use
    /// the same parser for both sources.
    pub async fn pr_diff(
        &self,
        pr: &PrRef,
        local_path: Option<&Path>,
        base_ref: Option<&str>,
        head_ref: Option<&str>,
    ) -> GhResult<PrDiff> {
        if let (Some(path), Some(base), Some(head)) = (local_path, base_ref, head_ref) {
            if path.exists() {
                match self.pr_diff_local(path, base, head).await {
                    Ok(diff) => return Ok(diff),
                    Err(e) => {
                        tracing::warn!(
                            local_path = ?path,
                            error = %e,
                            "local git diff failed; falling back to gh REST"
                        );
                    }
                }
            }
        }
        self.pr_diff_rest(pr).await
    }

    async fn pr_diff_local(
        &self,
        local_path: &Path,
        base_ref: &str,
        head_ref: &str,
    ) -> GhResult<PrDiff> {
        let started = Instant::now();
        let label = format!("git fetch+diff {}..{}", base_ref, head_ref);

        // 1. Fetch the base and head refs from origin so our diff is
        //    against the latest server state, not a stale local clone.
        //    `--no-tags --prune` keeps the fetch tight.
        let fetch_args = [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "origin",
            base_ref,
            head_ref,
        ];
        let fetch_res = self
            .inner
            .exec
            .run_in_dir(local_path, "git", &fetch_args)
            .await;
        let fetch_ok = fetch_res.is_ok();
        if let Err(e) = fetch_res {
            tracing::warn!(error = %e, "git fetch origin base+head failed; trying diff anyway");
        }

        // 2. Resolve the head SHA so the frontend can attach review
        //    comments at the right commit.
        let head_sha = self
            .inner
            .exec
            .run_in_dir(
                local_path,
                "git",
                &["rev-parse", &format!("origin/{head_ref}")],
            )
            .await
            .ok()
            .map(|o| o.stdout.trim().to_string())
            .filter(|s| !s.is_empty());

        // 3. `git diff origin/base...origin/head` — three-dot for the
        //    "merge base to head" diff (matches GitHub's PR view).
        let range = format!("origin/{base_ref}...origin/{head_ref}");
        let diff_args = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "--full-index",
            &range,
        ];
        let out = self
            .inner
            .exec
            .run_in_dir(local_path, "git", &diff_args)
            .await
            .map_err(GhError::Shell)?;
        let mut files = split_git_diff(&out.stdout);

        // Fetch full file contents for both sides of every non-binary
        // file so the frontend can expand unchanged hunks (Pierre's
        // `MultiFileDiff` needs the whole pre/post images to compute
        // expansion). Two `git show` calls per file is cheap on a
        // local clone (the objects are already there post-fetch) and
        // happens entirely in parallel with the rest of the UI mount
        // because the engine's command runs on a Tokio worker.
        //
        // For added files, the base object doesn't exist → leave
        // `old_content = None`. For removed files, head doesn't have
        // it → leave `new_content = None`. Binary files skip both.
        for file in &mut files {
            if file.binary {
                continue;
            }
            // Base side — use the rename-aware old path when present
            // so we read the file from where it lived before the move.
            let base_path = file.old_path.as_deref().unwrap_or(&file.path);
            if !matches!(file.status, FileStatus::Added) {
                file.old_content = git_show(
                    &self.inner.exec,
                    local_path,
                    &format!("origin/{base_ref}"),
                    base_path,
                )
                .await;
            }
            // Head side — `path` is post-rename so it points at the
            // current location.
            if !matches!(file.status, FileStatus::Removed) {
                file.new_content = git_show(
                    &self.inner.exec,
                    local_path,
                    &format!("origin/{head_ref}"),
                    &file.path,
                )
                .await;
            }
        }

        self.inner
            .log
            .record(GhCall::new(&label, started.elapsed(), fetch_ok));

        Ok(PrDiff {
            files,
            head_sha,
            source: DiffSource::LocalGit,
        })
    }

    // ─── Review comments (inline, anchored to file:line:side) ──────────

    /// List every **unresolved** inline review comment on `pr`. Sourced
    /// via GraphQL (`pullRequest.reviewThreads`) rather than the REST
    /// `/pulls/{n}/comments` endpoint because GraphQL is the only
    /// place we can read the per-thread node id (needed to call
    /// `resolveReviewThread`) and the per-thread `isResolved` flag
    /// (so we can drop already-closed threads server-side).
    ///
    /// One GraphQL round-trip returns:
    ///   * thread node id + `isResolved` (skip resolved)
    ///   * thread `path` / `line` / `originalLine` / `diffSide`
    ///   * every comment's `databaseId` (numeric REST id),
    ///     `body`, `createdAt`, `url`, `author.login`,
    ///     `replyTo.databaseId`
    ///
    /// Outdated threads (whose target line no longer exists in the
    /// current diff — `line == null`) are dropped at the parsing
    /// stage. Promoting them needs an "outdated" affordance the
    /// frontend doesn't have yet.
    pub async fn list_pr_review_comments(
        &self,
        pr: &PrRef,
    ) -> GhResult<Vec<ReviewComment>> {
        let label = format!(
            "graphql review threads {}/{}#{}",
            pr.owner, pr.repo, pr.number
        );
        // 100 threads × 50 comments per thread is the same cap as the
        // old global Conversations fetch. PRs with more than that are
        // rare; if we ever hit it we'll add cursor pagination.
        let query = format!(
            r#"query {{
  repository(owner: "{owner}", name: "{repo}") {{
    pullRequest(number: {number}) {{
      reviewThreads(first: 100) {{
        nodes {{
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first: 50) {{
            nodes {{
              databaseId
              body
              createdAt
              url
              author {{ login }}
              replyTo {{ databaseId }}
            }}
          }}
        }}
      }}
    }}
  }}
}}"#,
            owner = pr.owner,
            repo = pr.repo,
            number = pr.number
        );
        let stdout = self
            .gh_retry(&label, &["api", "graphql", "-f", &format!("query={query}")])
            .await?;
        let parsed: Value = serde_json::from_str(&stdout)
            .map_err(|e| GhError::decode(label.clone(), e))?;
        if let Some(errors) = parsed.get("errors").and_then(|e| e.as_array()) {
            if let Some(first) = errors.first() {
                let msg = first
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                return Err(GhError::Graphql(msg.to_string()));
            }
        }
        let threads_node = parsed
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("pullRequest"))
            .and_then(|p| p.get("reviewThreads"))
            .cloned()
            .ok_or_else(|| {
                GhError::Unexpected("missing reviewThreads in GraphQL response".into())
            })?;
        let parsed_threads: ReviewThreadsGql = serde_json::from_value(threads_node)
            .map_err(|e| GhError::decode(label.clone(), e))?;

        let mut out: Vec<ReviewComment> = Vec::new();
        let mut dropped_resolved = 0usize;
        let mut dropped_outdated = 0usize;
        for thread in parsed_threads.nodes {
            if thread.is_resolved {
                dropped_resolved += 1;
                continue;
            }
            // Use `line` when present; outdated threads with a null
            // `line` are dropped (their target line is gone from the
            // current diff and rendering them would land on the wrong
            // row). `originalLine` is intentionally NOT used as a
            // fallback — see the doc-comment for context.
            let Some(line) = thread.line else {
                dropped_outdated += 1;
                continue;
            };
            let path = match thread.path {
                Some(p) => p,
                None => continue,
            };
            let side = match thread.diff_side.as_deref() {
                Some("LEFT") => DiffSide::Left,
                _ => DiffSide::Right,
            };
            for comment in thread.comments.nodes {
                let Some(database_id) = comment.database_id else {
                    continue;
                };
                out.push(ReviewComment {
                    id: database_id.to_string(),
                    thread_id: thread.id.clone(),
                    path: path.clone(),
                    line,
                    side,
                    body: comment.body.unwrap_or_default(),
                    author_login: comment.author.and_then(|a| a.login),
                    in_reply_to_id: comment
                        .reply_to
                        .and_then(|r| r.database_id)
                        .map(|id| id.to_string()),
                    created_at: comment.created_at.unwrap_or_default(),
                });
            }
        }
        tracing::info!(
            pr = %format!("{}/{}#{}", pr.owner, pr.repo, pr.number),
            kept = out.len(),
            dropped_resolved,
            dropped_outdated,
            "list_pr_review_comments: parsed GraphQL threads"
        );
        // Stable order by created_at so reply chains land in
        // chronological order under their parent line.
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(out)
    }

    /// List every general (non-code-anchored) PR comment — the
    /// timeline conversation that lives on github.com's
    /// "Conversation" tab. Sourced from `/repos/.../issues/{n}/comments`
    /// since PRs are issues for this endpoint. Paginated.
    ///
    /// Empty body / created_at fall back to defaults so a single
    /// malformed entry (rare, but possible on tombstoned comments)
    /// can't fail the whole fetch.
    pub async fn list_pr_issue_comments(
        &self,
        pr: &PrRef,
    ) -> GhResult<Vec<IssueComment>> {
        let path = format!(
            "repos/{}/{}/issues/{}/comments",
            pr.owner, pr.repo, pr.number
        );
        let label = format!(
            "issue comments {}/{}#{}",
            pr.owner, pr.repo, pr.number
        );
        let stdout = self
            .gh_retry(&label, &["api", &path, "--paginate"])
            .await?;
        let stdout_trim = stdout.trim();
        if stdout_trim.is_empty() {
            return Ok(Vec::new());
        }
        // `--paginate` stitches pages with `][`. Same trick the diff
        // path uses.
        let normalised = stdout.replace("][", ",");
        let raw: Vec<RestIssueComment> = serde_json::from_str(&normalised)
            .map_err(|e| {
                tracing::warn!(
                    pr = %format!("{}/{}#{}", pr.owner, pr.repo, pr.number),
                    error = %e,
                    body_preview = &stdout_trim[..stdout_trim.len().min(200)],
                    "list_pr_issue_comments: serde decode failed"
                );
                GhError::decode(label.clone(), e)
            })?;
        let mut out = Vec::with_capacity(raw.len());
        for r in raw {
            out.push(IssueComment {
                id: r.id.to_string(),
                body: r.body.unwrap_or_default(),
                author_login: r.user.and_then(|u| u.login),
                created_at: r.created_at.unwrap_or_default(),
                updated_at: r.updated_at,
                html_url: r.html_url,
            });
        }
        // Chronological order — oldest first matches what the user
        // sees on github.com's Conversation tab.
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(out)
    }

    /// Mark a review thread as resolved on GitHub. Mirrors the
    /// "Resolve conversation" button on github.com.
    ///
    /// `thread_id` is the GraphQL node id (e.g. `"PRRT_kwDO..."`)
    /// returned by [`Self::list_pr_review_comments`] on every
    /// `ReviewComment.thread_id`. The mutation is idempotent: calling
    /// it on an already-resolved thread returns success without
    /// side-effects.
    pub async fn resolve_review_thread(&self, thread_id: &str) -> GhResult<()> {
        let label = format!("graphql resolveReviewThread {thread_id}");
        // Pass the thread id via `-F` so gh splices it into the
        // GraphQL variables — avoids manual escaping in the query
        // string (thread ids are URL-safe base64 but the value is
        // user-controlled here, treat it as untrusted).
        let query = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
        let id_arg = format!("id={thread_id}");
        let stdout = self
            .gh_retry(&label, &["api", "graphql", "-f", &format!("query={query}"), "-F", &id_arg])
            .await?;
        // gh prints the GraphQL response on stdout. Inspect for
        // top-level errors (HTTP 200 with a GraphQL `errors` array
        // is GitHub's preferred error mode).
        if let Ok(parsed) = serde_json::from_str::<Value>(&stdout) {
            if let Some(errors) = parsed.get("errors").and_then(|e| e.as_array()) {
                if let Some(first) = errors.first() {
                    let msg = first
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    return Err(GhError::Graphql(msg.to_string()));
                }
            }
        }
        Ok(())
    }

    async fn pr_diff_rest(&self, pr: &PrRef) -> GhResult<PrDiff> {
        // Per-file patches come from the REST endpoint; GraphQL doesn't
        // expose `patch`. Up to 100 per page, paginated.
        let path = format!(
            "repos/{}/{}/pulls/{}/files",
            pr.owner, pr.repo, pr.number
        );
        let label = format!("pr files {}/{}#{}", pr.owner, pr.repo, pr.number);
        let stdout = self
            .gh_retry(
                &label,
                &["api", &path, "--paginate", "-X", "GET"],
            )
            .await?;

        let head_sha = self.fetch_pr_head_sha(pr).await.ok();

        if stdout.trim().is_empty() {
            return Ok(PrDiff {
                files: Vec::new(),
                head_sha,
                source: DiffSource::GhRest,
            });
        }

        // `--paginate` concatenates pages by stitching JSON arrays
        // (`][` between pages). Normalise into a single array.
        let normalised = stdout.replace("][", ",");
        let raw: Vec<RestFileEntry> = serde_json::from_str(&normalised)
            .map_err(|e| GhError::decode(label.clone(), e))?;

        let mut files = Vec::with_capacity(raw.len());
        for entry in raw {
            let status = FileStatus::from_gh(&entry.status);
            let old_path = entry.previous_filename.clone();
            // REST `patch` strings are bare hunks — no `diff --git`
            // header. Reconstruct a minimal header so the frontend can
            // run the same parser as the local-git path.
            let patch = if let Some(p) = entry.patch.as_deref() {
                let prev = old_path.as_deref().unwrap_or(&entry.filename);
                format!(
                    "diff --git a/{prev} b/{new}\n--- a/{prev}\n+++ b/{new}\n{p}\n",
                    prev = prev,
                    new = entry.filename,
                    p = p
                )
            } else {
                String::new()
            };
            let binary = entry.patch.is_none() && status != FileStatus::Removed
                && status != FileStatus::Added;
            files.push(FileDiff {
                path: entry.filename,
                old_path,
                status,
                additions: entry.additions,
                deletions: entry.deletions,
                patch,
                binary,
                // REST fallback doesn't fetch full file contents
                // (would require an extra API call per file). The
                // diff viewer falls back to patch-only mode when
                // these are absent — hunk expansion isn't available
                // in that case, which matches the user's likely
                // expectation: "I get expansion when I'm reviewing
                // a repo I have cloned locally".
                old_content: None,
                new_content: None,
            });
        }

        Ok(PrDiff {
            files,
            head_sha,
            source: DiffSource::GhRest,
        })
    }

    /// Resolve the PR's current head SHA via REST (cheap one-line call).
    async fn fetch_pr_head_sha(&self, pr: &PrRef) -> GhResult<String> {
        let path = format!("repos/{}/{}/pulls/{}", pr.owner, pr.repo, pr.number);
        let label = format!("pr head_sha {}/{}#{}", pr.owner, pr.repo, pr.number);
        let stdout = self
            .gh_retry(&label, &["api", &path, "-q", ".head.sha"])
            .await?;
        Ok(stdout.trim().to_string())
    }

    // ─── PR review comments (inline) ─────────────────────────────────────

    /// Post an inline review comment on a PR (a single-comment review).
    ///
    /// `commit_sha` should be the head commit's SHA (read from
    /// [`pr_diff`]'s `head_sha`). `line` is the 1-based line number on
    /// `side`. Mirrors `POST /repos/{owner}/{repo}/pulls/{n}/comments`.
    pub async fn add_review_comment(
        &self,
        pr: &PrRef,
        body: &str,
        commit_sha: &str,
        path: &str,
        line: u32,
        side: DiffSide,
    ) -> GhResult<()> {
        let api_path = format!(
            "repos/{}/{}/pulls/{}/comments",
            pr.owner, pr.repo, pr.number
        );
        let label = format!(
            "comment {}/{}#{} {}",
            pr.owner, pr.repo, pr.number, path
        );
        let line_arg = format!("line={line}");
        let side_arg = format!("side={}", side.as_wire());
        let commit_arg = format!("commit_id={commit_sha}");
        let path_arg = format!("path={path}");
        let body_arg = format!("body={body}");
        // `gh api -f` sends every value as a JSON string. GitHub's
        // POST /pulls/{n}/comments schema strict-types `line` as
        // **integer** — sending `"42"` gets rejected with a 422
        // and a confusing error like "Invalid request" with no
        // mention of the field. Use `-F` (typed) for line so it
        // serialises as a JSON number. The other fields stay
        // string-typed (path, commit_id, side, body all match
        // GitHub's schema as strings).
        self.gh_retry(
            &label,
            &[
                "api",
                &api_path,
                "-X",
                "POST",
                "-f",
                &commit_arg,
                "-f",
                &path_arg,
                "-F",
                &line_arg,
                "-f",
                &side_arg,
                "-f",
                &body_arg,
            ],
        )
        .await?;
        Ok(())
    }

    /// Reply to an existing inline review comment. Hits the dedicated
    /// `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies`
    /// endpoint, which inherits `path` / `line` / `side` / `commit_id`
    /// from the parent comment automatically — so the caller doesn't
    /// have to pass them again (and we can't get them wrong).
    ///
    /// `parent_id` is the REST id of the comment being replied to (or
    /// of any comment in the thread; GitHub attaches the reply to the
    /// thread regardless).
    pub async fn reply_review_comment(
        &self,
        pr: &PrRef,
        parent_id: u64,
        body: &str,
    ) -> GhResult<()> {
        let api_path = format!(
            "repos/{}/{}/pulls/{}/comments/{}/replies",
            pr.owner, pr.repo, pr.number, parent_id
        );
        let label = format!(
            "reply {}/{}#{} parent={}",
            pr.owner, pr.repo, pr.number, parent_id
        );
        let body_arg = format!("body={body}");
        self.gh_retry(
            &label,
            &["api", &api_path, "-X", "POST", "-f", &body_arg],
        )
        .await?;
        Ok(())
    }

    /// Edit an existing inline review comment body.
    /// Hits `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}`.
    pub async fn edit_review_comment(
        &self,
        pr: &PrRef,
        comment_id: u64,
        body: &str,
    ) -> GhResult<()> {
        let api_path = format!(
            "repos/{}/{}/pulls/comments/{}",
            pr.owner, pr.repo, comment_id
        );
        let label = format!(
            "edit review comment {}/{}#{} id={}",
            pr.owner, pr.repo, pr.number, comment_id
        );
        let body_arg = format!("body={body}");
        self.gh_retry(&label, &["api", "-X", "PATCH", &api_path, "-f", &body_arg])
            .await?;
        Ok(())
    }

    /// Edit an existing general (issue) comment body.
    /// Hits `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`.
    pub async fn edit_issue_comment(
        &self,
        pr: &PrRef,
        comment_id: u64,
        body: &str,
    ) -> GhResult<()> {
        let api_path = format!(
            "repos/{}/{}/issues/comments/{}",
            pr.owner, pr.repo, comment_id
        );
        let label = format!(
            "edit issue comment {}/{}#{} id={}",
            pr.owner, pr.repo, pr.number, comment_id
        );
        let body_arg = format!("body={body}");
        self.gh_retry(&label, &["api", "-X", "PATCH", &api_path, "-f", &body_arg])
            .await?;
        Ok(())
    }

    /// Add `login` to the PR's requested-reviewers list.
    pub async fn add_reviewer(&self, pr: &PrRef, login: &str) -> GhResult<()> {
        let path = format!(
            "repos/{}/{}/pulls/{}/requested_reviewers",
            pr.owner, pr.repo, pr.number
        );
        let label = format!("add reviewer {} {}/{}#{}", login, pr.owner, pr.repo, pr.number);
        let reviewer_arg = format!("reviewers[]={login}");
        self.gh_retry(
            &label,
            &["api", &path, "-X", "POST", "-f", &reviewer_arg],
        )
        .await?;
        Ok(())
    }
}

impl Default for GhClient {
    fn default() -> Self {
        Self::new()
    }
}

/// REST entry returned by `gh api .../pulls/{n}/files`.
#[derive(Debug, Deserialize)]
struct RestFileEntry {
    filename: String,
    status: String,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    #[serde(default)]
    patch: Option<String>,
    #[serde(default)]
    previous_filename: Option<String>,
}

/// GraphQL DTOs for `pullRequest.reviewThreads`. Mirror the shape we
/// query in `list_pr_review_comments` — every text field is defensive
/// (tombstoned comments occasionally return null `body`, etc.) so a
/// single malformed entry doesn't fail the entire fetch.
#[derive(Debug, Deserialize)]
struct ReviewThreadsGql {
    nodes: Vec<ReviewThreadNode>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadNode {
    /// Thread node id (`PRRT_kwDO...`) — needed by the
    /// `resolveReviewThread` mutation.
    id: String,
    #[serde(rename = "isResolved", default)]
    is_resolved: bool,
    #[serde(default)]
    path: Option<String>,
    /// Line in the LATEST diff. `null` for threads whose target line
    /// no longer exists.
    #[serde(default)]
    line: Option<u32>,
    /// `LEFT` (deletion side) or `RIGHT` (addition / context side).
    /// Optional because older repos / replays sometimes omit it.
    #[serde(rename = "diffSide", default)]
    diff_side: Option<String>,
    comments: ReviewThreadCommentsGql,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCommentsGql {
    nodes: Vec<ReviewThreadCommentGql>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCommentGql {
    /// REST numeric id. May be null on extremely-recent comments
    /// before GitHub backfills it; we drop those (they re-appear on
    /// the next refresh).
    #[serde(rename = "databaseId", default)]
    database_id: Option<i64>,
    #[serde(default)]
    body: Option<String>,
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
    #[serde(default)]
    author: Option<ReviewThreadCommentAuthorGql>,
    #[serde(rename = "replyTo", default)]
    reply_to: Option<ReviewThreadReplyToGql>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadCommentAuthorGql {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadReplyToGql {
    #[serde(rename = "databaseId", default)]
    database_id: Option<i64>,
}

/// REST entry returned by `gh api .../issues/{n}/comments`. Defensive
/// — every text field is optional so a tombstoned / partial entry
/// doesn't fail the whole list parse.
#[derive(Debug, Deserialize)]
struct RestIssueComment {
    id: i64,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    user: Option<RestIssueCommentUser>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RestIssueCommentUser {
    #[serde(default)]
    login: Option<String>,
}

/// `git show {ref}:{path}` → file contents at that revision, or `None`
/// when the object doesn't exist (added/removed file on the wrong
/// side, binary blob without a textual representation, etc.). Errors
/// are swallowed and reported at the caller's discretion — failing
/// here would block the entire diff render, which the frontend can
/// already cope with by falling back to patch-only mode.
async fn git_show(
    exec: &ShellExecutor,
    cwd: &Path,
    revision: &str,
    path: &str,
) -> Option<String> {
    let spec = format!("{revision}:{path}");
    match exec.run_in_dir(cwd, "git", &["show", &spec]).await {
        Ok(out) => Some(out.stdout),
        Err(e) => {
            tracing::debug!(spec = %spec, error = %e, "git show failed; treating as missing");
            None
        }
    }
}


/// GraphQL fragment for one PR's detail, embedded in the batched query.
const PR_FRAGMENT: &str = r#"      headRefName
      baseRefName
      reviewDecision
      reviews(first: 50) {
        nodes {
          author { login }
          state
        }
      }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User { login }
            ... on Team { name }
          }
        }
      }
      comments(first: 1) {
        totalCount
      }
      mergedBy { login }
      mergedAt
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
      files(first: 100) {
        nodes { path }
      }"#;

