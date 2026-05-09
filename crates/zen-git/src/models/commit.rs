//! Commit / branch / file-change DTOs returned by [`crate::log`] and
//! [`crate::diff`].

use serde::{Deserialize, Serialize};

/// One commit, decoded from the custom `git log --pretty=format:…` payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Full 40-char SHA-1.
    pub hash: String,
    /// Short hash convenience field (first 7 chars of [`hash`](Self::hash)).
    pub short_hash: String,
    /// Parent SHAs (0 entries for the root commit, 1 for a normal commit, 2+ for a merge).
    pub parents: Vec<String>,
    /// Author display name (`%an`).
    pub author_name: String,
    /// Author email (`%ae`).
    pub author_email: String,
    /// Author unix timestamp (`%at`).
    pub author_ts: i64,
    /// Committer display name (`%cn`).
    pub committer_name: String,
    /// Committer email (`%ce`).
    pub committer_email: String,
    /// Committer unix timestamp (`%ct`).
    pub committer_ts: i64,
    /// First commit-message line (`%s`).
    pub subject: String,
    /// Body of the commit message after the subject (`%b`); may be empty.
    pub body: String,
    /// Branch / tag refs pointing to this commit, populated by a separate
    /// `git for-each-ref` query and stitched in by [`crate::log`].
    #[serde(default)]
    pub refs: Vec<String>,
}

impl Commit {
    /// `true` if the commit has more than one parent (i.e. it's a merge).
    pub fn is_merge(&self) -> bool {
        self.parents.len() > 1
    }
}

/// A local or remote branch ref returned by [`crate::repos::list_branches`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    /// Short name (`main`, `origin/main`, …).
    pub name: String,
    /// Full ref name (`refs/heads/main`, `refs/remotes/origin/main`).
    pub full_name: String,
    /// `true` if this is the currently checked-out branch.
    pub is_head: bool,
    /// `true` if this is a remote-tracking ref (`refs/remotes/…`).
    pub is_remote: bool,
    /// Tip commit SHA.
    pub tip: String,
}

/// One file changed by a commit (`A`/`M`/`D`/`R`/`C`/`T`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Single-letter status code from `git show --name-status`.
    pub status: FileChangeStatus,
    /// Repo-relative path (post-rename).
    pub path: String,
    /// Pre-rename path when [`status`](Self::status) is `R` or `C`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
}

/// Subset of `git diff --name-status` letters relevant to the UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileChangeStatus {
    /// Added.
    A,
    /// Modified.
    M,
    /// Deleted.
    D,
    /// Renamed.
    R,
    /// Copied.
    C,
    /// Type-changed (regular file ↔ symlink ↔ submodule).
    T,
    /// Anything else (fall-back for forward compatibility).
    Other,
}

impl FileChangeStatus {
    /// Parse the leading letter of a `--name-status` line.
    pub fn from_letter(c: char) -> Self {
        match c {
            'A' => Self::A,
            'M' => Self::M,
            'D' => Self::D,
            'R' => Self::R,
            'C' => Self::C,
            'T' => Self::T,
            _ => Self::Other,
        }
    }
}

/// Per-file unified diff for a single commit, suitable for direct
/// rendering in the existing `DiffViewer` component.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Repo-relative path (post-rename).
    pub path: String,
    /// Pre-rename path when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
    /// Status letter.
    pub status: FileChangeStatus,
    /// Raw unified-diff text (`git diff --no-color`).
    pub patch: String,
    /// `true` when git classified the file as binary (no patch text).
    pub binary: bool,
}
