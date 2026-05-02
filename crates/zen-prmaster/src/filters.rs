//! Notification filter persistence + matching — port of
//! `Sources/PRMaster/Models/NotificationFilter.swift`.
//!
//! Storage: a SQLite database opened at
//! `~/Library/Application Support/com.zen-tools.app/prmaster/prmaster.db`.
//! The schema is pinned by the constants below; future migrations land
//! in this module via incrementing `SCHEMA_VERSION`.

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use globset::{Glob, GlobMatcher};
use parking_lot::Mutex;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use zen_github::PullRequest;

/// macOS / Linux app data directory under `dirs::data_dir()` (mirrors
/// Tauri's `app_data_dir`).
fn default_data_dir() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.zen-tools.app").join("prmaster")
}

/// PRMaster notification action — mirrors Swift's `NotificationAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationAction {
    /// Banner with default sound.
    SoundBanner,
    /// Banner with no sound.
    SilentBanner,
    /// Bump the badge count without showing a banner.
    BadgeOnly,
    /// Suppress completely.
    Mute,
}

impl NotificationAction {
    /// Wire string used in SQLite + JSON.
    pub fn as_wire(self) -> &'static str {
        match self {
            NotificationAction::SoundBanner => "sound_banner",
            NotificationAction::SilentBanner => "silent_banner",
            NotificationAction::BadgeOnly => "badge_only",
            NotificationAction::Mute => "mute",
        }
    }

    /// Inverse of [`as_wire`].
    pub fn from_wire(s: &str) -> Self {
        match s {
            "sound_banner" => NotificationAction::SoundBanner,
            "silent_banner" => NotificationAction::SilentBanner,
            "badge_only" => NotificationAction::BadgeOnly,
            "mute" => NotificationAction::Mute,
            _ => NotificationAction::SoundBanner,
        }
    }
}

/// One persisted notification filter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationFilter {
    /// Stable id (UUID v4).
    pub id: String,
    /// Human-readable label.
    pub name: String,
    /// Author logins to match (empty = any).
    #[serde(default)]
    pub authors: Vec<String>,
    /// Repo full names (`owner/repo`) or short names. Empty = any.
    #[serde(default)]
    pub repos: Vec<String>,
    /// File-path globs (e.g. `src/**/*.rs`). Empty = any.
    #[serde(default)]
    pub file_globs: Vec<String>,
    /// Optional case-insensitive regex against the PR title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_regex: Option<String>,
    /// What to do on match.
    pub action: NotificationAction,
    /// Disabled filters never match.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Wall-clock UNIX millis the filter was created.
    pub created_at_ms: i64,
    /// Wall-clock UNIX millis of the last edit.
    pub updated_at_ms: i64,
}

fn default_true() -> bool {
    true
}

impl NotificationFilter {
    /// Build a fresh filter with a new UUID and timestamps.
    pub fn new(name: impl Into<String>) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            authors: Vec::new(),
            repos: Vec::new(),
            file_globs: Vec::new(),
            title_regex: None,
            action: NotificationAction::SoundBanner,
            enabled: true,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    /// Whether this filter matches the given PR + optional file paths.
    /// Mirrors Swift's `NotificationFilter.matches(pr:filePaths:)`.
    pub fn matches(&self, pr: &PullRequest, file_paths: &[String]) -> bool {
        if !self.enabled {
            return false;
        }
        if !self.authors.is_empty() {
            let Some(author) = pr.author.as_ref().map(|a| a.login.as_str()) else {
                return false;
            };
            if !self.authors.iter().any(|a| a == author) {
                return false;
            }
        }
        if !self.repos.is_empty() {
            let nwo = pr.repository.name_with_owner.as_str();
            let short = pr.repository.short_name();
            if !self.repos.iter().any(|r| r == nwo || r == short) {
                return false;
            }
        }
        if let Some(pat) = self.title_regex.as_deref() {
            if !pat.is_empty() {
                let with_flag = if pat.starts_with("(?i)") {
                    pat.to_string()
                } else {
                    format!("(?i){pat}")
                };
                let Ok(re) = Regex::new(&with_flag) else {
                    return false;
                };
                if !re.is_match(&pr.title) {
                    return false;
                }
            }
        }
        if !self.file_globs.is_empty() {
            let matchers: Vec<GlobMatcher> = self
                .file_globs
                .iter()
                .filter_map(|g| Glob::new(g).ok())
                .map(|g| g.compile_matcher())
                .collect();
            if matchers.is_empty() {
                return false;
            }
            let any = file_paths
                .iter()
                .any(|p| matchers.iter().any(|m| m.is_match(p)));
            if !any {
                return false;
            }
        }
        true
    }
}

/// Errors raised by the filter store.
#[derive(Debug, Error)]
pub enum FilterStoreError {
    /// Underlying SQLite or filesystem failure.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// I/O failure creating the data directory.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// SQLite-backed CRUD store for [`NotificationFilter`].
#[derive(Clone)]
pub struct FilterStore {
    inner: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for FilterStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilterStore").finish_non_exhaustive()
    }
}

impl FilterStore {
    /// Open (or create) the filter store at the standard PRMaster data
    /// directory.
    pub fn open_default() -> Result<Self, FilterStoreError> {
        let dir = default_data_dir();
        std::fs::create_dir_all(&dir)?;
        Self::open_at(&dir.join("prmaster.db"))
    }

    /// Open at an explicit path (`":memory:"` for tests).
    pub fn open_at(path: impl AsRef<std::path::Path>) -> Result<Self, FilterStoreError> {
        let conn = Connection::open(path.as_ref())?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS notification_filters (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                authors       TEXT NOT NULL DEFAULT '[]',
                repos         TEXT NOT NULL DEFAULT '[]',
                file_globs    TEXT NOT NULL DEFAULT '[]',
                title_regex   TEXT,
                action        TEXT NOT NULL,
                enabled       INTEGER NOT NULL DEFAULT 1,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    /// List every filter, ordered by creation time (oldest first).
    pub fn list(&self) -> Result<Vec<NotificationFilter>, FilterStoreError> {
        let conn = self.inner.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, authors, repos, file_globs, title_regex, action, enabled, created_at_ms, updated_at_ms
             FROM notification_filters ORDER BY created_at_ms ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NotificationFilter {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    authors: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    repos: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                    file_globs: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                    title_regex: row.get(5)?,
                    action: NotificationAction::from_wire(&row.get::<_, String>(6)?),
                    enabled: row.get::<_, i64>(7)? != 0,
                    created_at_ms: row.get(8)?,
                    updated_at_ms: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Insert or update a filter.
    pub fn save(&self, filter: &NotificationFilter) -> Result<(), FilterStoreError> {
        let conn = self.inner.lock();
        conn.execute(
            "INSERT INTO notification_filters (id, name, authors, repos, file_globs, title_regex, action, enabled, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               authors = excluded.authors,
               repos = excluded.repos,
               file_globs = excluded.file_globs,
               title_regex = excluded.title_regex,
               action = excluded.action,
               enabled = excluded.enabled,
               updated_at_ms = excluded.updated_at_ms",
            params![
                filter.id,
                filter.name,
                serde_json::to_string(&filter.authors).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&filter.repos).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&filter.file_globs).unwrap_or_else(|_| "[]".into()),
                filter.title_regex,
                filter.action.as_wire(),
                if filter.enabled { 1_i64 } else { 0_i64 },
                filter.created_at_ms,
                filter.updated_at_ms,
            ],
        )?;
        Ok(())
    }

    /// Delete a filter by id. No-op if it doesn't exist.
    pub fn delete(&self, id: &str) -> Result<(), FilterStoreError> {
        let conn = self.inner.lock();
        conn.execute("DELETE FROM notification_filters WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use zen_github::{Author, Repository};

    fn pr(author: &str, repo: &str, title: &str) -> PullRequest {
        PullRequest {
            number: 1,
            title: title.into(),
            url: "u".into(),
            state: "OPEN".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_draft: false,
            author: Some(Author {
                login: author.into(),
                ..Default::default()
            }),
            repository: Repository {
                name: repo.split_once('/').map(|(_, r)| r.to_string()).unwrap_or_else(|| repo.into()),
                name_with_owner: repo.into(),
            },
        }
    }

    #[test]
    fn match_skips_disabled() {
        let mut f = NotificationFilter::new("test");
        f.enabled = false;
        assert!(!f.matches(&pr("alice", "octo/repo", "feat: x"), &[]));
    }

    #[test]
    fn match_filters_by_author() {
        let mut f = NotificationFilter::new("a");
        f.authors = vec!["alice".into()];
        assert!(f.matches(&pr("alice", "octo/repo", "x"), &[]));
        assert!(!f.matches(&pr("bob", "octo/repo", "x"), &[]));
    }

    #[test]
    fn match_filters_by_repo_short_or_full() {
        let mut f = NotificationFilter::new("r");
        f.repos = vec!["octo/repo".into()];
        assert!(f.matches(&pr("a", "octo/repo", "x"), &[]));
        f.repos = vec!["repo".into()];
        assert!(f.matches(&pr("a", "octo/repo", "x"), &[]));
    }

    #[test]
    fn match_filters_by_title_regex_case_insensitive() {
        let mut f = NotificationFilter::new("t");
        f.title_regex = Some("^FEAT".into());
        assert!(f.matches(&pr("a", "octo/repo", "feat: foo"), &[]));
        assert!(!f.matches(&pr("a", "octo/repo", "fix: foo"), &[]));
    }

    #[test]
    fn match_filters_by_file_globs() {
        let mut f = NotificationFilter::new("g");
        f.file_globs = vec!["src/**/*.rs".into()];
        assert!(f.matches(
            &pr("a", "octo/repo", "x"),
            &["src/lib/foo.rs".into(), "README.md".into()]
        ));
        assert!(!f.matches(
            &pr("a", "octo/repo", "x"),
            &["docs/x.md".into()]
        ));
    }

    #[test]
    fn store_round_trip() {
        let store = FilterStore::open_at(":memory:").unwrap();
        let mut f = NotificationFilter::new("first");
        f.authors = vec!["alice".into()];
        store.save(&f).unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, f.id);
        store.delete(&f.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }
}
