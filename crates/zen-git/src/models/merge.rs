//! Merge-state DTOs returned by [`crate::merge_state`], [`crate::conflict`],
//! and [`crate::merge_ops`].

use serde::{Deserialize, Serialize};

use super::commit::Commit;

/// What kind of "in progress" operation the working tree currently holds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    /// Plain `git merge` (the worktree has `MERGE_HEAD`).
    Merge,
    /// `git rebase` (the worktree has `rebase-merge/` or `rebase-apply/`).
    Rebase,
    /// `git cherry-pick` (the worktree has `CHERRY_PICK_HEAD`).
    CherryPick,
    /// `git revert` (the worktree has `REVERT_HEAD`). Surface so the
    /// continue/abort buttons still work; the merge editor shares the
    /// same conflict shape.
    Revert,
    /// Nothing in progress.
    None,
}

/// Snapshot of the in-progress operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    /// Operation kind (`None` when the working tree is clean).
    pub kind: MergeKind,
    /// HEAD ref name (`refs/heads/main` style) at the time the op started.
    /// `None` when the kind is `None`.
    pub head: Option<String>,
    /// Display label for the incoming side ("origin/feature", "<sha>"). Best-effort.
    pub incoming: Option<String>,
    /// Number of unresolved conflicting paths in the index.
    pub unresolved: u32,
}

/// Per-file conflict status from `git status --porcelain=v2 -z`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStatus {
    /// Both sides modified — typical 3-way conflict.
    BothModified,
    /// Added by us, added by them.
    BothAdded,
    /// Deleted by us, modified by them.
    DeletedByUs,
    /// Modified by us, deleted by them.
    DeletedByThem,
    /// Added by us only.
    AddedByUs,
    /// Added by them only.
    AddedByThem,
    /// Anything else — surfaced verbatim so the UI can show "manual".
    Other,
}

/// One conflicting path returned by [`crate::conflict::list_unmerged`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Repo-relative path.
    pub path: String,
    /// Conflict kind.
    pub status: ConflictStatus,
    /// `true` when at least one side is binary (the 3-way editor refuses
    /// these and asks the user to resolve externally).
    #[serde(default)]
    pub binary: bool,
}

/// Three blob payloads (one per index stage) that feed the 3-way
/// merge editor.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlobs {
    /// Stage 1 — common ancestor. `None` when the file was added on
    /// both sides ("both added").
    pub base: Option<String>,
    /// Stage 2 — HEAD-side blob. `None` when "added by them" /
    /// "deleted by us".
    pub local: Option<String>,
    /// Stage 3 — incoming-side blob. `None` when "added by us" /
    /// "deleted by them".
    pub remote: Option<String>,
    /// Current contents of the worktree file (with conflict markers if
    /// `git merge` left them in). Populated alongside the stage blobs
    /// so the editor can pick up the user's in-flight edits.
    #[serde(default)]
    pub working: Option<String>,
    /// `true` when any side is binary — the editor renders a placeholder.
    #[serde(default)]
    pub binary: bool,
}

/// What [`crate::merge_ops::preview_merge`] returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// Branch we'd merge **into** (target).
    pub into: String,
    /// Branch we'd merge **from** (source).
    pub from: String,
    /// `true` when the merge would be a fast-forward (no commit needed).
    pub fast_forward: bool,
    /// Predicted unresolved paths.
    pub conflicts: Vec<String>,
    /// Commits in `from` not yet in `into` (most recent first).
    pub incoming_commits: Vec<Commit>,
    /// Files changed by the trial merge.
    pub files_changed: Vec<String>,
}
