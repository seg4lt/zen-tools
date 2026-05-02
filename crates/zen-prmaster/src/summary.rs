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

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zen_ai_cli::{AiError, AiProvider, AiProviderType};
use zen_github::{GhError, GhResult};
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
    /// Underlying `gh` CLI error.
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
/// Always-included header + commit messages, followed by diffs truncated
/// to fit the token budget (chars / token_ratio).
pub fn build_prompt(
    repo: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
    commits: &[EnrichedCommit],
    token_ratio: usize,
    budget_tokens: usize,
) -> String {
    let mut buf = String::new();
    buf.push_str("You are summarising a developer's recent commits across one repository.\n\n");
    buf.push_str(&format!(
        "Repository: {repo}\nDate range: {} → {} (UTC)\nCommit count: {}\n\n",
        since.to_rfc3339(),
        until.to_rfc3339(),
        commits.len(),
    ));
    buf.push_str("Write a short Markdown summary (under 250 words):\n");
    buf.push_str("- 1 top-level bullet per *theme* or *area* — group commits, don't list every one\n");
    buf.push_str("- prefer present-tense, active voice (\"adds X\", \"refactors Y\")\n");
    buf.push_str("- end with one line headed `Notable risks:` if you spot any\n\n");
    buf.push_str("--- Commit messages ---\n");
    for c in commits {
        let first = c.message.lines().next().unwrap_or("").trim();
        buf.push_str(&format!("{} ({}): {}\n", c.short_sha, c.author_date.format("%Y-%m-%d"), first));
    }
    buf.push_str("\n--- Diffs (may be truncated) ---\n");

    let ratio = token_ratio.max(1);
    let budget_chars = budget_tokens.saturating_mul(ratio);
    let header_chars = buf.chars().count();
    let mut remaining = budget_chars.saturating_sub(header_chars);
    for c in commits {
        let Some(diff) = c.diff.as_deref() else {
            continue;
        };
        let mut snippet = if diff.len() > MAX_DIFF_CHARS {
            format!(
                "{}\n[…truncated {} bytes…]\n",
                &diff[..MAX_DIFF_CHARS],
                diff.len() - MAX_DIFF_CHARS
            )
        } else {
            diff.to_string()
        };
        if snippet.len() > remaining {
            if remaining < 200 {
                buf.push_str(&format!(
                    "\n[…remaining {} commit diff(s) skipped — token budget reached…]\n",
                    commits
                        .iter()
                        .skip_while(|x| x.sha != c.sha)
                        .count(),
                ));
                break;
            }
            snippet.truncate(remaining);
            snippet.push_str("\n[…truncated by token budget…]\n");
        }
        let block = format!(
            "\n=== {} {} ===\n{}\n",
            c.short_sha,
            c.message.lines().next().unwrap_or("").trim(),
            snippet
        );
        if block.len() > remaining {
            break;
        }
        remaining -= block.len();
        buf.push_str(&block);
    }

    buf
}

/// Derive a fresh [`SummaryCard`] for the given params using the supplied
/// AI provider, optionally honouring a [`LocalRepoMapping`] for offline
/// `git log` / `git show`.
pub async fn generate_summary(
    params: &AiSummaryParams,
    provider: &dyn AiProvider,
    gh: &zen_github::GhClient,
    mapping: Option<&LocalRepoMapping>,
    token_ratio: usize,
) -> Result<SummaryCard, SummaryError> {
    let author = match params.author.as_deref() {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => gh.whoami().await?,
    };

    let commits = match mapping {
        Some(m) => fetch_commits_local(&m.local_path, &author, params.since, params.until).await?,
        None => fetch_commits_remote(gh, &params.repo, &author, params.since, params.until).await?,
    };

    if commits.is_empty() {
        return Err(SummaryError::NoCommits);
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

async fn fetch_commits_remote(
    gh: &zen_github::GhClient,
    repo: &str,
    author: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<EnrichedCommit>, SummaryError> {
    let value = gh
        .list_repo_commits(repo, author, &since.to_rfc3339(), &until.to_rfc3339())
        .await?;
    let entries = value.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let sha = entry
            .get("sha")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let message = entry
            .get("commit")
            .and_then(|c| c.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let author_date = entry
            .get("commit")
            .and_then(|c| c.get("author"))
            .and_then(|a| a.get("date"))
            .and_then(|d| d.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok())
            .unwrap_or(since);
        if sha.is_empty() {
            continue;
        }
        let diff = match gh.commit_diff(repo, &sha).await {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::warn!(repo, sha, error = %e, "commit_diff failed");
                None
            }
        };
        out.push(EnrichedCommit {
            short_sha: sha.chars().take(7).collect(),
            sha,
            message,
            author_date,
            diff,
        });
    }
    Ok(out)
}

async fn fetch_commits_local(
    repo_path: &str,
    author: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<EnrichedCommit>, SummaryError> {
    let exec = ShellExecutor::bare();
    let format = "%H%x09%aI%x09%s";
    let since_arg = format!("--since={}", since.to_rfc3339());
    let until_arg = format!("--until={}", until.to_rfc3339());
    let author_arg = format!("--author={author}");
    let pretty_arg = format!("--pretty=format:{format}");
    let path = std::path::Path::new(repo_path);
    let log = exec
        .run_in_dir(
            path,
            "git",
            &[
                "log",
                "--no-color",
                "--all",
                &author_arg,
                &since_arg,
                &until_arg,
                &pretty_arg,
            ],
        )
        .await?;
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
    fn build_prompt_includes_commit_messages() {
        let commits = vec![EnrichedCommit {
            sha: "abc1234".into(),
            short_sha: "abc1234".into(),
            message: "feat: new flow".into(),
            author_date: ts("2024-01-01T00:00:00Z"),
            diff: Some("diff --git a/foo b/foo\n+hello".into()),
        }];
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-02T00:00:00Z"),
            &commits,
            2,
            1000,
        );
        assert!(prompt.contains("feat: new flow"));
        assert!(prompt.contains("octo/repo"));
        assert!(prompt.contains("=== abc1234 feat: new flow ==="));
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
        let prompt = build_prompt(
            "octo/repo",
            ts("2024-01-01T00:00:00Z"),
            ts("2024-01-02T00:00:00Z"),
            &commits,
            2,
            500,
        );
        assert!(prompt.contains("truncated"));
    }
}
