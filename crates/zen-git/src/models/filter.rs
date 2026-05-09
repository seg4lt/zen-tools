//! `CommitLogFilter` mirrors IntelliJ's "Git Log" filter panel — every
//! field maps cleanly to a `git log` flag.

use serde::{Deserialize, Serialize};

/// Where in the commit/diff to apply [`TextSearch::query`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextScope {
    /// `--grep <q>`.
    Message,
    /// `-S <q>` — pickaxe: commits that change the number of occurrences
    /// of `q` in some file.
    Changes,
    /// `-G <q>` — pickaxe by regex on the diff hunks themselves.
    ChangesRegex,
}

/// A free-text query plus `Aa` / `.*` toggles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearch {
    /// Raw query string.
    pub query: String,
    /// Where the query is applied (commit message vs. diff content).
    pub scope: TextScope,
    /// `true` when the user has the `Aa` chip on. When off we add `-i`.
    #[serde(default)]
    pub case_sensitive: bool,
    /// `true` when the user has the `.*` chip on. Maps to `-E` (extended
    /// regex) for [`TextScope::Message`]; for the pickaxe scopes git
    /// already treats `-G` as a regex and `-S` as a literal substring.
    #[serde(default)]
    pub regex: bool,
}

impl TextSearch {
    /// `true` if the query is empty / whitespace-only — callers skip the
    /// search flag entirely so we don't pass `--grep=""` (which matches
    /// every commit).
    pub fn is_empty(&self) -> bool {
        self.query.trim().is_empty()
    }
}

/// Full IntelliJ-style filter set passed to [`crate::log::list_commits`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogFilter {
    /// Branch name or revision range (`main`, `main..feature`, `--all`).
    /// When `None` the log walks `HEAD`.
    #[serde(default)]
    pub branch: Option<String>,
    /// `--author=<u>` substring filter.
    #[serde(default)]
    pub author: Option<String>,
    /// `--since=<iso>` lower bound.
    #[serde(default)]
    pub since: Option<String>,
    /// `--until=<iso>` upper bound.
    #[serde(default)]
    pub until: Option<String>,
    /// Optional repo-relative path scope (`-- <path>`).
    #[serde(default)]
    pub path: Option<String>,
    /// Free-text search across message / diff.
    #[serde(default)]
    pub text: Option<TextSearch>,
    /// `--merges` only.
    #[serde(default)]
    pub merges_only: bool,
    /// `--no-merges`.
    #[serde(default)]
    pub no_merges: bool,
    /// Hash-prefix filter applied client-side after the page is fetched
    /// (git itself has no native short-hash filter).
    #[serde(default)]
    pub hash_prefix: Option<String>,
    /// Pagination — number of commits to skip from the start.
    #[serde(default)]
    pub skip: u32,
    /// Pagination — page size (caller-defined; default 200 in the
    /// frontend).
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_limit() -> u32 {
    200
}
