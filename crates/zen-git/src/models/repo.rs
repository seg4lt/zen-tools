//! Repo-registry DTOs.

use serde::{Deserialize, Serialize};

/// One repo tracked in the registry. Persisted to `<config_dir>/repos.json`
/// and returned to the frontend verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// Absolute path to the working tree.
    pub path: String,
    /// Display label — defaults to the basename of `path` and is
    /// editable from the UI.
    pub label: String,
    /// ISO-8601 timestamp the repo was first added.
    pub added_at: String,
}
