//! Persisted list of repos the user has added to the Git tool.
//!
//! On-disk shape (`<config_dir>/repos.json`):
//! ```json
//! { "repos": [ { "path": "/abs", "label": "myrepo", "addedAt": "..." } ] }
//! ```
//!
//! Loaded lazily on first access; mutations rewrite the file
//! atomically (`write` -> rename via [`std::fs::write`] which replaces
//! in-place on POSIX & Windows).

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::GitResult;
use crate::models::repo::RepoEntry;

const REPOS_FILE: &str = "repos.json";

/// On-disk envelope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RepoFile {
    #[serde(default)]
    repos: Vec<RepoEntry>,
}

/// In-memory + on-disk registry of tracked repos.
#[derive(Debug, Clone, Default)]
pub struct RepoRegistry {
    repos: Vec<RepoEntry>,
}

impl RepoRegistry {
    /// Load the registry from `<config_dir>/repos.json`. Missing /
    /// empty file → empty registry.
    pub fn load(config_dir: &Path) -> GitResult<Self> {
        let path = config_dir.join(REPOS_FILE);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path)?;
        if bytes.is_empty() {
            return Ok(Self::default());
        }
        let file: RepoFile = serde_json::from_slice(&bytes)?;
        Ok(Self { repos: file.repos })
    }

    /// Snapshot of the current entries (cloned).
    pub fn list(&self) -> Vec<RepoEntry> {
        self.repos.clone()
    }

    /// Add a repo. Returns the inserted entry. Idempotent — re-adding
    /// an existing path returns the existing entry untouched.
    pub fn add(&mut self, path: &Path, label: Option<String>) -> RepoEntry {
        let canonical = canonical_or_self(path);
        let path_str = canonical.to_string_lossy().to_string();
        if let Some(existing) = self.repos.iter().find(|r| r.path == path_str) {
            return existing.clone();
        }
        let entry = RepoEntry {
            path: path_str,
            label: label.unwrap_or_else(|| {
                canonical
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| canonical.to_string_lossy().into_owned())
            }),
            added_at: Utc::now().to_rfc3339(),
        };
        self.repos.push(entry.clone());
        entry
    }

    /// Remove a repo by absolute path. No-op if the path isn't tracked.
    pub fn remove(&mut self, path: &Path) {
        let canonical = canonical_or_self(path).to_string_lossy().to_string();
        self.repos.retain(|r| r.path != canonical);
    }

    /// Update the label of an existing entry. Returns `false` if no
    /// entry matched.
    pub fn set_label(&mut self, path: &Path, label: String) -> bool {
        let canonical = canonical_or_self(path).to_string_lossy().to_string();
        if let Some(r) = self.repos.iter_mut().find(|r| r.path == canonical) {
            r.label = label;
            true
        } else {
            false
        }
    }

    /// Persist the current state to `<config_dir>/repos.json`.
    pub fn save(&self, config_dir: &Path) -> GitResult<()> {
        std::fs::create_dir_all(config_dir)?;
        let path = config_dir.join(REPOS_FILE);
        let body = serde_json::to_vec_pretty(&RepoFile {
            repos: self.repos.clone(),
        })?;
        std::fs::write(path, body)?;
        Ok(())
    }
}

fn canonical_or_self(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Default config directory used when `GitEngine::new` doesn't get one
/// passed in: `<data_dir>/com.seg4lt.zen-tools/git`.
pub fn default_config_dir() -> PathBuf {
    const APP_BUNDLE: &str = "com.seg4lt.zen-tools";
    const SUBDIR: &str = "git";
    dirs_data_or_home()
        .join(APP_BUNDLE)
        .join(SUBDIR)
}

fn dirs_data_or_home() -> PathBuf {
    // Mirror `zen_prmaster::paths::data_dir` without forcing every consumer
    // to depend on `dirs` directly.
    if let Some(d) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        return d;
    }
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            return home.join("Library/Application Support");
        }
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            return appdata;
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

