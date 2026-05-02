//! `gh`-CLI-backed GitHub client. Every method shells out via [`zen_shell`].

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use zen_shell::{ShellError, ShellExecutor};

use crate::call_log::{CallLog, GhCall};
use crate::error::{GhError, GhResult};
use crate::models::auth::AuthStatus;
use crate::models::conversation::{
    ConversationGroup, ConversationItem, ConversationKind, ConversationMessage,
};
use crate::models::pull_request::{
    EnrichedPullRequest, PrDetail, PrRef, PullRequest, ReviewEvent,
};

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

    /// Union of `--involves @me` and `--mentions @me` PRs (deduped). Drives
    /// the Conversations tab.
    pub async fn search_conversations_candidates(&self) -> GhResult<Vec<PullRequest>> {
        let involved = self.search_prs(
            "search prs --involves @me",
            &[
                "search", "prs", "--involves", "@me", "--state", "open", "--limit", "100",
                "--json", SEARCH_JSON_FIELDS,
            ],
        );
        let mentioned = self.search_prs(
            "search prs --mentions @me",
            &[
                "search", "prs", "--mentions", "@me", "--state", "open", "--limit", "100",
                "--json", SEARCH_JSON_FIELDS,
            ],
        );
        let (a, b) = tokio::join!(involved, mentioned);
        let mut combined = a?;
        combined.extend(b?);
        let mut seen = ahash::AHashSet::new();
        combined.retain(|pr| seen.insert(pr.id()));
        Ok(combined)
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

    // ─── Conversations (review threads + @mentions) ──────────────────────

    /// Fetch every unresolved review thread and @mention comment touching
    /// the current user across the open PRs they're involved in.
    /// Mirrors `Sources/PRMaster/Services/GitHubService.swift::fetchConversations`.
    pub async fn fetch_conversations(
        &self,
        current_user: &str,
    ) -> GhResult<Vec<ConversationGroup>> {
        let candidates = self.search_conversations_candidates().await?;
        let candidates: Vec<PullRequest> = candidates.into_iter().filter(|p| p.is_open()).collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        let user_lower = current_user.to_ascii_lowercase();

        // Issue all GraphQL fetches concurrently.
        let mut handles = Vec::with_capacity(candidates.len());
        for pr in &candidates {
            let this = self.clone();
            let pr_clone = pr.clone();
            let user = user_lower.clone();
            handles.push(tokio::spawn(async move {
                match this.fetch_conversation_detail(&pr_clone).await {
                    Ok(detail) => detail.into_items(&pr_clone, &user),
                    Err(e) => {
                        tracing::warn!(
                            pr = %pr_clone.id(),
                            error = %e,
                            "fetch_conversation_detail failed; skipping"
                        );
                        Vec::new()
                    }
                }
            }));
        }

        let mut all_items: Vec<ConversationItem> = Vec::new();
        for handle in handles {
            if let Ok(items) = handle.await {
                all_items.extend(items);
            }
        }

        // Dedup by id, keep the first occurrence (matches Swift's
        // `uniquingKeysWith: { current, _ in current }`).
        let mut seen = ahash::AHashSet::new();
        all_items.retain(|item| seen.insert(item.id.clone()));
        all_items.sort_by(|a, b| b.latest_activity_at.cmp(&a.latest_activity_at));

        // Group by PR id.
        let mut groups: ahash::AHashMap<String, Vec<ConversationItem>> = ahash::AHashMap::new();
        for item in all_items {
            groups.entry(item.pr_id.clone()).or_default().push(item);
        }

        let mut out: Vec<ConversationGroup> = groups
            .into_iter()
            .filter_map(|(_, mut items)| {
                items.sort_by(|a, b| b.latest_activity_at.cmp(&a.latest_activity_at));
                let head = items.first()?;
                Some(ConversationGroup {
                    pr_id: head.pr_id.clone(),
                    pr_title: head.pr_title.clone(),
                    pr_number: head.pr_number,
                    repo_name_with_owner: head.repo_name_with_owner.clone(),
                    pr_url: head.pr_url.clone(),
                    conversations: items,
                })
            })
            .collect();

        out.sort_by(|a, b| {
            b.latest_activity_at()
                .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC)
                .cmp(
                    &a.latest_activity_at()
                        .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC),
                )
        });
        Ok(out)
    }

    async fn fetch_conversation_detail(
        &self,
        pr: &PullRequest,
    ) -> GhResult<ConversationDetailGraphql> {
        let (owner, repo) = pr.repository.split();
        let query = format!(
            r#"query {{
  repository(owner: "{owner}", name: "{repo}") {{
    pullRequest(number: {number}) {{
      number
      title
      url
      comments(first: 50) {{
        nodes {{
          id
          body
          createdAt
          url
          author {{ login }}
        }}
      }}
      reviewThreads(first: 50) {{
        nodes {{
          id
          isResolved
          path
          line
          originalLine
          comments(first: 50) {{
            nodes {{
              id
              body
              createdAt
              url
              author {{ login }}
            }}
          }}
        }}
      }}
    }}
  }}
}}"#,
            owner = owner,
            repo = repo,
            number = pr.number
        );

        let label = format!("graphql conversations {}#{}", pr.repository.short_name(), pr.number);
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
        let value = parsed
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("pullRequest"))
            .ok_or_else(|| GhError::Unexpected("missing pullRequest in conversation response".into()))?
            .clone();
        serde_json::from_value::<ConversationDetailGraphql>(value)
            .map_err(|e| GhError::decode(label, e))
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

// ─── Conversation GraphQL DTOs ───────────────────────────────────────────
//
// These mirror the private structs in
// `Sources/PRMaster/Services/GitHubService.swift` (lines 933–1055). They're
// kept private to this module — public callers see [`ConversationGroup`]
// and [`ConversationItem`] from `models::conversation`.

#[derive(Debug, Deserialize)]
struct ConversationDetailGraphql {
    #[serde(default)]
    comments: Option<ConversationCommentNodes>,
    #[serde(default, rename = "reviewThreads")]
    review_threads: Option<ReviewThreadNodesGql>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadNodesGql {
    nodes: Vec<ReviewThreadGql>,
}

#[derive(Debug, Deserialize)]
struct ReviewThreadGql {
    id: String,
    #[serde(rename = "isResolved")]
    is_resolved: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u64>,
    #[serde(default, rename = "originalLine")]
    original_line: Option<u64>,
    comments: ConversationCommentNodes,
}

#[derive(Debug, Deserialize)]
struct ConversationCommentNodes {
    nodes: Vec<ConversationCommentGql>,
}

#[derive(Debug, Deserialize)]
struct ConversationCommentGql {
    id: String,
    body: String,
    #[serde(rename = "createdAt")]
    created_at: chrono::DateTime<chrono::Utc>,
    url: String,
    #[serde(default)]
    author: Option<ConversationAuthorGql>,
}

#[derive(Debug, Deserialize)]
struct ConversationAuthorGql {
    #[serde(default)]
    login: Option<String>,
}

impl ConversationCommentGql {
    fn into_message(self) -> ConversationMessage {
        ConversationMessage {
            id: self.id,
            author_login: self.author.and_then(|a| a.login),
            body: self.body,
            created_at: self.created_at,
            url: self.url,
        }
    }
}

impl ConversationDetailGraphql {
    /// Mirrors `ConversationPRDetail.conversationItems(for:)` in Swift.
    /// `current_user` is expected to be lower-cased already.
    fn into_items(self, pr: &PullRequest, current_user: &str) -> Vec<ConversationItem> {
        let pr_id = pr.id();
        let mut out = Vec::new();

        // Review threads: include if unresolved AND the user participated
        // or was @-mentioned anywhere in the thread.
        if let Some(threads) = self.review_threads {
            for thread in threads.nodes {
                if thread.is_resolved {
                    continue;
                }
                let messages: Vec<ConversationMessage> = thread
                    .comments
                    .nodes
                    .into_iter()
                    .map(|c| c.into_message())
                    .collect();
                let user_participated = messages.iter().any(|m| {
                    m.author_login
                        .as_deref()
                        .map(|s| s.eq_ignore_ascii_case(current_user))
                        .unwrap_or(false)
                });
                let user_mentioned = messages.iter().any(|m| body_mentions(&m.body, current_user));
                if !(user_participated || user_mentioned) {
                    continue;
                }
                let Some(latest) = messages.iter().map(|m| m.created_at).max() else {
                    continue;
                };
                let exact_url = messages
                    .last()
                    .map(|m| m.url.clone())
                    .unwrap_or_else(|| pr.url.clone());

                let mut sorted = messages;
                sorted.sort_by(|a, b| a.created_at.cmp(&b.created_at));

                out.push(ConversationItem {
                    id: thread.id,
                    pr_id: pr_id.clone(),
                    pr_title: pr.title.clone(),
                    pr_number: pr.number,
                    repo_name_with_owner: pr.repository.name_with_owner.clone(),
                    pr_url: pr.url.clone(),
                    kind: ConversationKind::ReviewThread,
                    file_path: thread.path,
                    line_number: thread.line.or(thread.original_line),
                    latest_activity_at: latest,
                    exact_url,
                    messages: sorted,
                    current_user_login: Some(current_user.to_string()),
                });
            }
        }

        // Top-level comments that @-mention the user.
        if let Some(comments) = self.comments {
            for comment in comments.nodes {
                if !body_mentions(&comment.body, current_user) {
                    continue;
                }
                let msg = comment.into_message();
                out.push(ConversationItem {
                    id: msg.id.clone(),
                    pr_id: pr_id.clone(),
                    pr_title: pr.title.clone(),
                    pr_number: pr.number,
                    repo_name_with_owner: pr.repository.name_with_owner.clone(),
                    pr_url: pr.url.clone(),
                    kind: ConversationKind::MentionComment,
                    file_path: None,
                    line_number: None,
                    latest_activity_at: msg.created_at,
                    exact_url: msg.url.clone(),
                    messages: vec![msg],
                    current_user_login: Some(current_user.to_string()),
                });
            }
        }

        out
    }
}

/// Word-boundary `@username` matcher. Mirrors Swift's `String.containsMention(of:)`.
fn body_mentions(body: &str, username_lower: &str) -> bool {
    let body_lower = body.to_ascii_lowercase();
    let target = format!("@{username_lower}");
    let bytes = body_lower.as_bytes();
    let target_bytes = target.as_bytes();
    let mut idx = 0;
    while let Some(pos) = body_lower[idx..].find(&target) {
        let abs = idx + pos;
        let before_ok = abs == 0
            || !is_username_char(bytes[abs - 1] as char);
        let after = abs + target_bytes.len();
        let after_ok = after >= bytes.len()
            || !is_username_char(bytes[after] as char);
        if before_ok && after_ok {
            return true;
        }
        idx = abs + target_bytes.len();
    }
    false
}

fn is_username_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_mentions_handles_word_boundary() {
        assert!(body_mentions("hey @octocat please look", "octocat"));
        assert!(body_mentions("@octocat", "octocat"));
        assert!(body_mentions("(@octocat)", "octocat"));
        assert!(!body_mentions("email me at notoctocat@example.com", "octocat"));
        assert!(!body_mentions("hi @octocatlong", "octocat"));
    }

    #[test]
    fn body_mentions_is_case_insensitive() {
        assert!(body_mentions("Hi @OctoCat please review", "octocat"));
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

