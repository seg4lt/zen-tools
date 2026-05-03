//! AI Summary orchestration — port of
//! `Sources/PRMaster/Services/SummaryGenerator.swift` (simplified).
//!
//! For each `(repo, date-range)` pair we:
//!   1. Fetch the user's commits in the range — preferring local
//!      `git log` when a [`LocalRepoMapping`] exists, falling back to
//!      `gh api repos/{repo}/commits`.
//!   2. Fetch the per-commit diff (local `git show` or
//!      `gh api repos/{repo}/commits/{sha}` with the diff Accept header).
//!   3. Bundle commit messages + truncated diffs into a single prompt
//!      (token budget computed from the user's `ai_token_ratio`).
//!   4. Hand the prompt to the active [`zen_ai_cli::AiProvider`].
//!   5. Cache the resulting card in `ai_summary_cache.json` keyed by
//!      `"{repo}:{since}:{until}"`.
//!
//! The Swift code adds adaptive batching for huge commit sets; we skip
//! that here in favour of a single prompt + diff truncation. The user
//! sees the same "one card per repo per date range" output.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zen_ai_cli::{AiError, AiProvider};
use zen_github::GhError;
use zen_shell::{ShellError, ShellExecutor};

use crate::settings::LocalRepoMapping;

/// Default per-call token budget (matches Swift `AIProviderConfig.claude.maxTokensPerCall / 2`).
const DEFAULT_BUDGET: usize = 30_000;
/// Hard cap on per-commit diff size after truncation.
const MAX_DIFF_CHARS: usize = 20_000;

/// One AI Summary input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSummaryParams {
    /// Repository full name (`owner/repo`).
    pub repo: String,
    /// Inclusive start (ISO-8601, with offset).
    pub since: DateTime<Utc>,
    /// Exclusive end.
    pub until: DateTime<Utc>,
    /// GitHub login whose commits we summarise (defaults to the current
    /// user when empty).
    #[serde(default)]
    pub author: Option<String>,
    /// Override the ai provider model (passed straight through).
    #[serde(default)]
    pub model: Option<String>,
    /// Force a fresh refetch even when a cached card is available.
    #[serde(default)]
    pub force: bool,
}

/// One generated summary card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryCard {
    /// Repository full name.
    pub repo: String,
    /// Inclusive start.
    pub since: DateTime<Utc>,
    /// Exclusive end.
    pub until: DateTime<Utc>,
    /// Commit count fed into the prompt.
    pub commit_count: usize,
    /// Markdown summary returned by the AI provider.
    pub summary: String,
    /// Cost in USD, when reported by the provider.
    pub cost_usd: Option<f64>,
    /// Wall-clock generation time, UNIX millis.
    pub generated_at_ms: i64,
}

/// Errors raised by [`generate_summary`].
#[derive(Debug, Error)]
pub enum SummaryError {
    /// Underlying `gh` CLI error. Retained even though the summary
    /// commit-fetch path no longer hits `gh` (we read commits from
    /// the user's local clone via `git log`); other engine code paths
    /// still surface this variant when they propagate gh failures
    /// through `SummaryError`.
    #[error(transparent)]
    Gh(#[from] GhError),
    /// AI provider failed.
    #[error(transparent)]
    Ai(#[from] AiError),
    /// Shell-out (local `git`) failed.
    #[error(transparent)]
    Shell(#[from] ShellError),
    /// Cache I/O failed.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// No commits found in the requested range.
    #[error("no commits in range")]
    NoCommits,
    /// The repo isn't mapped to a local clone in Settings → Local
    /// repo mappings, and the AI summary path now requires a local
    /// clone (we read commits via `git log`, not `gh api`).
    #[error("no local repo mapping configured for {0} — add one in Settings → Local repo mappings")]
    MissingMapping(String),
}

/// One commit + its (optional, possibly-truncated) diff.
#[derive(Debug, Clone)]
pub struct EnrichedCommit {
    /// Full commit SHA.
    pub sha: String,
    /// First 7 characters of the SHA for display.
    pub short_sha: String,
    /// Commit message (full).
    pub message: String,
    /// Author timestamp (UTC).
    pub author_date: DateTime<Utc>,
    /// Unified-diff text (None when the diff fetch failed).
    pub diff: Option<String>,
}

/// JSON cache file at `~/Library/.../prmaster/ai_summary_cache.json`.
#[derive(Clone)]
pub struct AiSummaryCache {
    path: PathBuf,
    inner: Arc<Mutex<HashMap<String, SummaryCard>>>,
}

impl std::fmt::Debug for AiSummaryCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiSummaryCache")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl AiSummaryCache {
    /// Open at `dir/ai_summary_cache.json` (created if missing).
    pub fn open_in(dir: &std::path::Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("ai_summary_cache.json");
        let map = if let Ok(bytes) = std::fs::read(&path) {
            serde_json::from_slice::<HashMap<String, SummaryCard>>(&bytes)
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(map)),
        })
    }

    fn save(&self, map: &HashMap<String, SummaryCard>) {
        if let Ok(bytes) = serde_json::to_vec(map) {
            let tmp = self.path.with_extension("tmp");
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    /// Cache key for `(repo, since, until)`.
    pub fn key(repo: &str, since: DateTime<Utc>, until: DateTime<Utc>) -> String {
        format!("{repo}:{}:{}", since.timestamp_millis(), until.timestamp_millis())
    }

    /// Look up a cached card.
    pub fn get(&self, key: &str) -> Option<SummaryCard> {
        self.inner.lock().get(key).cloned()
    }

    /// Insert or replace a card.
    pub fn put(&self, key: String, card: SummaryCard) {
        let mut map = self.inner.lock();
        map.insert(key, card);
        self.save(&map);
    }

    /// Drop everything.
    pub fn clear(&self) {
        let mut map = self.inner.lock();
        map.clear();
        self.save(&map);
    }
}

/// Stitch enriched commits into the prompt the provider sees.
///
/// The output is meant to be **forwarded to a manager / leadership**,
/// not pasted into a teammate's PR review. So the framing is:
///
///   - Audience: an engineering manager who skims, not a peer who'll
///     read every commit. They want headline impact, not mechanics.
///   - Tone: confident and outcome-focused. Lead with delivered value
///     (features shipped, problems fixed, reliability / performance
///     wins, unblocks for the team) and frame mechanics — refactors,
///     test scaffolding, infra moves — as enablers of that value.
///   - Style: still factual, no inflation. Don't claim impact that
///     isn't supported by the diff.
///
/// Layout:
///   1. **Role + framing** — sets up the manager-report tone.
///   2. **Run header** — repo, human-readable date range, commit count.
///   3. **Output instructions** — required Markdown shape, plus rules
///      about the *style* (highlight outcomes, avoid SHAs / mechanics
///      narrative, no inflation).
///   4. **Commit messages** — one line per commit so the model can
///      cross-reference.
///   5. **Diffs** — fenced ```diff blocks per commit, truncated to fit
///      `(budget_tokens × token_ratio)` characters. Per-commit cap is
///      [`MAX_DIFF_CHARS`]; commits past the budget are summarised as
///      "N commits skipped" so the model knows the picture is
///      incomplete and hedges accordingly.
pub fn build_prompt(
    repo: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    commits: &[EnrichedCommit],
    token_ratio: usize,
    budget_tokens: usize,
) -> String {
    let date_label = format_date_label(since, until);

    let mut buf = String::new();
    // 1 — role + framing (manager-report tone)
    buf.push_str(
        "You are writing a weekly engineering report **for a manager / \
         leadership audience**, not a peer code review. Read the commit \
         messages and diffs below and produce a confident, outcome-focused \
         summary that highlights what was delivered and why it matters.\n\
         \n\
         Lean into impact: features shipped, customer-visible bugs fixed, \
         reliability or performance gains, scope unblocked for the team, \
         technical debt paid down. Treat refactors / test work / infra \
         moves as enablers — connect them to the outcome they support \
         (\"refactored X to unblock the Y rollout\") rather than narrating \
         them on their own. Do not invent impact the diff doesn't support; \
         when the work is genuinely internal plumbing, say so plainly but \
         frame why it matters.\n\n",
    );

    // 2 — run header
    buf.push_str(&format!(
        "**Repository:** `{repo}`\n\
         **Date range:** {date_label}\n\
         **Commit count:** {n}\n\n",
        n = commits.len(),
    ));

    // 3 — output instructions
    buf.push_str("# Output\n\n");
    buf.push_str(&format!(
        "Reply with Markdown in **exactly** this shape:\n\
         \n\
         ```\n\
         ## {date_label} — `{repo}`\n\
         \n\
         **Highlights:** <one or two sentences naming the headline wins of \
         the week — what shipped, what got better, what unblocked the team>\n\
         \n\
         - <outcome-led bullet>\n\
         - <outcome-led bullet>\n\
         …\n\
         \n\
         **Watch list:** <one short sentence on risks / follow-ups the manager should know about — omit the line entirely if nothing notable>\n\
         ```\n\n",
    ));
    buf.push_str(
        "Rules:\n\
         - Open every bullet with the **outcome** (what got better, who \
           benefits) and only then mention the mechanism. Good: \"Cut PR \
           page load by ~40% by batching the GraphQL detail query.\" Bad: \
           \"Refactored fetchPRs into batched queries.\"\n\
         - Group related commits into a single bullet — one bullet per \
           *theme* or *area*, not one per commit. Aim for 3–7 bullets.\n\
         - Use present-tense, active voice. Name the subsystem / feature / \
           customer surface when it matters; avoid the file-by-file play-\
           by-play.\n\
         - Do **not** mention commit SHAs, list individual commits, or \
           paste diff hunks back. Do not pad the report — if a week is \
           genuinely light, write a short report.\n\
         - Stay under ~250 words across the whole report.\n\
         - Don't oversell. If the diff is mostly internal cleanup, the \
           Highlights line should say so honestly (\"quiet week — focus on \
           paying down test debt before the X launch\") rather than \
           inflating routine work.\n\n",
    );

    // 4 — commit messages
    buf.push_str("# Commits\n\n");
    for c in commits {
        let first = c.message.lines().next().unwrap_or("").trim();
        buf.push_str(&format!(
            "- `{}` {}: {}\n",
            c.short_sha,
            c.author_date.format("%Y-%m-%d"),
            first,
        ));
    }
    buf.push_str("\n");

    // 5 — diffs (token-budgeted)
    buf.push_str("# Diffs\n\n");
    let ratio = token_ratio.max(1);
    let budget_chars = budget_tokens.saturating_mul(ratio);
    let header_chars = buf.chars().count();
    let mut remaining = budget_chars.saturating_sub(header_chars);
    let mut included = 0usize;

    for (idx, c) in commits.iter().enumerate() {
        let Some(diff) = c.diff.as_deref() else {
            continue;
        };

        // Per-commit cap so a single huge diff can't starve the rest.
        let mut body = if diff.len() > MAX_DIFF_CHARS {
            format!(
                "{}\n... (truncated; {} more bytes in this commit)",
                &diff[..MAX_DIFF_CHARS],
                diff.len() - MAX_DIFF_CHARS,
            )
        } else {
            diff.to_string()
        };

        let header = format!(
            "## `{}` {}\n\n```diff\n",
            c.short_sha,
            c.message.lines().next().unwrap_or("").trim(),
        );
        let footer = "\n```\n\n";
        let chrome_chars = header.len() + footer.len();

        // Not enough room for a useful chunk → bail and tell the model.
        if remaining < chrome_chars + 200 {
            let skipped = commits.len().saturating_sub(idx);
            buf.push_str(&format!(
                "_…{} more commit diff(s) omitted to fit the token budget — base your summary on the commit messages above for those._\n",
                skipped,
            ));
            break;
        }

        let allowed_body = remaining - chrome_chars;
        if body.len() > allowed_body {
            body.truncate(allowed_body);
            body.push_str("\n... (truncated to fit token budget)");
        }
        buf.push_str(&header);
        buf.push_str(&body);
        buf.push_str(footer);
        remaining = remaining.saturating_sub(chrome_chars + body.len());
        included += 1;
    }

    if included == 0 && commits.iter().any(|c| c.diff.is_some()) {
        buf.push_str(
            "_(No diffs included — token budget was too tight. Summarise from the commit messages above.)_\n",
        );
    }

    buf
}

/// Render a UTC range as `Sep 1 – Sep 7, 2024` (or just `Sep 1, 2024`
/// when both ends fall on the same calendar day). Designed for the
/// prompt header so the model gets a human-readable label rather than
/// a raw RFC-3339 string.
fn format_date_label(since: DateTime<Utc>, until: DateTime<Utc>) -> String {
    let same_day = since.date_naive() == until.date_naive();
    if same_day {
        since.format("%b %-d, %Y").to_string()
    } else if since.year() == until.year() {
        format!(
            "{} – {}",
            since.format("%b %-d"),
            until.format("%b %-d, %Y"),
        )
    } else {
        format!(
            "{} – {}",
            since.format("%b %-d, %Y"),
            until.format("%b %-d, %Y"),
        )
    }
}

/// Derive a fresh [`SummaryCard`] for the given params, reading
/// commits from the user's **local clone** of the repo.
///
/// `mapping` is required: the heatmap-driven AI tab only summarises
/// repos that have a `LocalRepoMapping` in Settings, and there's no
/// good reason to hit `gh api repos/{repo}/commits` for the summary
/// path when the same data is sitting on disk and `git log` is
/// orders of magnitude faster + rate-limit-free. (`gh` is still used
/// by the rest of the engine — PR list, refresh, repo enumeration,
/// notifications — just not here.)
///
/// Author filtering is the **union** of:
///   1. `params.author` if the caller explicitly supplied one,
///      otherwise the local repo's `git config user.email` /
///      `user.name` ("primary author").
///   2. Every entry in `extra_authors` (Settings → "Additional
///      authors") — useful when the user's git identity has shifted
///      over the years or when they want to roll up a teammate's
///      commits into the same report.
///
/// `git log` accepts repeated `--author=<value>` flags and OR-s
/// them, with substring matching against the commit author's name
/// AND email — so plain logins, full emails, or display names all
/// work as inputs.
pub async fn generate_summary(
    params: &AiSummaryParams,
    provider: &dyn AiProvider,
    mapping: &LocalRepoMapping,
    token_ratio: usize,
    extra_authors: &[String],
) -> Result<SummaryCard, SummaryError> {
    let primary = match params.author.as_deref() {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => git_author(&mapping.local_path).await.unwrap_or_default(),
    };

    // Combine primary + extras, trimming, skipping empties, and
    // de-duping case-insensitively so we don't emit a redundant
    // `--author=` flag for the same identity.
    let mut authors: Vec<String> = Vec::new();
    if !primary.is_empty() {
        authors.push(primary);
    }
    for raw in extra_authors {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if authors
            .iter()
            .any(|a| a.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        authors.push(trimmed.to_string());
    }

    let commits =
        fetch_commits_local(&mapping.local_path, &authors, params.since, params.until)
            .await?;

    if commits.is_empty() {
        // Treat "no commits" as a successful but empty result rather
        // than an error. The frontend uses `commit_count == 0` as the
        // signal for "park this repo in the compact 'no commits this
        // week' section so it doesn't waste a full grid cell". The
        // empty card persists like any other so we don't re-fetch on
        // every Generate.
        return Ok(SummaryCard {
            repo: params.repo.clone(),
            since: params.since,
            until: params.until,
            commit_count: 0,
            summary: String::from("_No commits in this range._"),
            cost_usd: None,
            generated_at_ms: chrono::Utc::now().timestamp_millis(),
        });
    }

    let prompt = build_prompt(
        &params.repo,
        params.since,
        params.until,
        &commits,
        token_ratio,
        DEFAULT_BUDGET,
    );

    let response = provider
        .summarise(&prompt, params.model.as_deref())
        .await?;

    Ok(SummaryCard {
        repo: params.repo.clone(),
        since: params.since,
        until: params.until,
        commit_count: commits.len(),
        summary: response.text,
        cost_usd: response.cost_usd,
        generated_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

/// Read the local repo's git identity for use as the `git log
/// --author=` filter. Tries `user.email` first (it's the canonical
/// commit-author key), then `user.name`. Returns `None` when neither
/// is set; callers fall back to "no filter" so the summary still
/// runs against every commit in range rather than failing outright.
async fn git_author(repo_path: &str) -> Option<String> {
    let exec = ShellExecutor::bare();
    let path = std::path::Path::new(repo_path);
    for key in ["user.email", "user.name"] {
        if let Ok(out) = exec
            .run_in_dir(path, "git", &["config", "--get", key])
            .await
        {
            let trimmed = out.stdout.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

async fn fetch_commits_local(
    repo_path: &str,
    authors: &[String],
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<EnrichedCommit>, SummaryError> {
    let exec = ShellExecutor::bare();
    let format = "%H%x09%aI%x09%s";
    let since_arg = format!("--since={}", since.to_rfc3339());
    let until_arg = format!("--until={}", until.to_rfc3339());
    let pretty_arg = format!("--pretty=format:{format}");
    let path = std::path::Path::new(repo_path);
    // Build one `--author=<value>` flag per resolved author. When the
    // list is empty we drop the filter entirely so the summary widens
    // to every commit in range rather than silently returning none —
    // important when the local repo has no `user.email` configured.
    let author_args: Vec<String> = authors
        .iter()
        .map(|a| format!("--author={a}"))
        .collect();
    let mut args: Vec<&str> = vec![
        "log",
        "--no-color",
        "--all",
        &since_arg,
        &until_arg,
        &pretty_arg,
    ];
    for a in &author_args {
        args.push(a);
    }
    let log = exec.run_in_dir(path, "git", &args).await?;
    let mut out = Vec::new();
    for line in log.stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let sha = match parts.next() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let date_str = parts.next().unwrap_or("");
        let subject = parts.next().unwrap_or("").to_string();
        let author_date = date_str
            .parse::<DateTime<Utc>>()
            .unwrap_or(since);
        let diff = match exec
            .run_in_dir(
                path,
                "git",
                &["show", "--format=", "--no-color", &sha],
            )
            .await
        {
            Ok(out) => Some(out.stdout),
            Err(e) => {
                tracing::warn!(repo_path, sha, error = %e, "local git show failed");
                None
            }
        };
        out.push(EnrichedCommit {
            short_sha: sha.chars().take(7).collect(),
            sha,
            message: subject,
            author_date,
            diff,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(s: &str) -> DateTime<Utc> {
        Utc.datetime_from_str(s, "%Y-%m-%dT%H:%M:%SZ").unwrap()
    }

    #[test]
    fn cache_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AiSummaryCache::open_in(dir.path()).unwrap();
        let card = SummaryCard {
            repo: "octo/repo".into(),
            since: ts("2024-01-01T00:00:00Z"),
            until: ts("2024-01-02T00:00:00Z"),
            commit_count: 3,
            summary: "* worked on x\n* refactored y".into(),
            cost_usd: Some(0.05),
            generated_at_ms: 1,
        };
        let key = AiSummaryCache::key(&card.repo, card.since, card.until);
        cache.put(key.clone(), card.clone());
        let reopened = AiSummaryCache::open_in(dir.path()).unwrap();
        assert_eq!(reopened.get(&key).unwrap().summary, card.summary);
        reopened.clear();
        assert!(reopened.get(&key).is_none());
    }

    #[test]
    fn build_prompt_includes_commit_messages_and_diff_block() {
        let commits = vec![EnrichedCommit {
            sha: "abc1234".into(),
            short_sha: "abc1234".into(),
            message: "feat: new flow".into(),
            author_date: ts("2024-01-01T00:00:00Z"),
            diff: Some("diff --git a/foo b/foo\n+hello".into()),
        }];
        // Generous budget (2.5k tokens × ratio 2 = 5k chars) so the
        // header instructions don't crowd the diff section out.
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-02T00:00:00Z"),
            &commits,
            2,
            2500,
        );
        // Run header + commit message + diff fence.
        assert!(prompt.contains("**Repository:** `octo/repo`"));
        assert!(prompt.contains("feat: new flow"));
        assert!(prompt.contains("## `abc1234` feat: new flow"));
        assert!(prompt.contains("```diff"));
        // Manager-report framing — make sure the audience is clear and
        // SHAs are blocked from the output.
        assert!(prompt.contains("manager / leadership audience"));
        assert!(prompt.contains("Do **not** mention commit SHAs"));
        // Required output shape includes Highlights + Watch list.
        assert!(prompt.contains("**Highlights:**"));
        assert!(prompt.contains("**Watch list:**"));
    }

    #[test]
    fn build_prompt_truncates_when_over_budget() {
        let huge_diff = "diff\n".repeat(20_000); // 100kB
        let commits = vec![EnrichedCommit {
            sha: "abc1234".into(),
            short_sha: "abc1234".into(),
            message: "huge".into(),
            author_date: ts("2024-01-01T00:00:00Z"),
            diff: Some(huge_diff),
        }];
        // Budget 1500 tokens × ratio 2 = 3000 chars. The header
        // instructions alone are ~1.2k chars so the diff has ~1.8k of
        // room — which the 100kB diff blows past, forcing truncation.
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-02T00:00:00Z"),
            &commits,
            2,
            1500,
        );
        assert!(prompt.contains("truncated"));
    }

    #[test]
    fn build_prompt_uses_human_date_label_when_range_spans_multiple_days() {
        let commits = vec![EnrichedCommit {
            sha: "abc1234".into(),
            short_sha: "abc1234".into(),
            message: "x".into(),
            author_date: ts("2024-01-01T00:00:00Z"),
            diff: None,
        }];
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-07T23:59:59Z"),
            &commits,
            2,
            1000,
        );
        // Human label rather than rfc3339 in the headings.
        assert!(prompt.contains("Jan 1 – Jan 7, 2024"));
        assert!(prompt.contains("## Jan 1 – Jan 7, 2024"));
    }

    #[test]
    fn build_prompt_uses_single_day_label_when_range_collapses() {
        let commits = vec![EnrichedCommit {
            sha: "abc1234".into(),
            short_sha: "abc1234".into(),
            message: "x".into(),
            author_date: ts("2024-01-01T00:00:00Z"),
            diff: None,
        }];
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-01T23:59:59Z"),
            &commits,
            2,
            1000,
        );
        assert!(prompt.contains("Jan 1, 2024"));
    }
}
