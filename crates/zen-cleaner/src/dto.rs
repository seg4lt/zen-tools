//! Serialisable IPC shapes mirroring [`crate::tree`] for the Tauri layer.
//!
//! `PathBuf` lives only in the core types; on the wire we always use
//! [`String`] so the front-end doesn't have to think about OS path
//! encoding.

use crate::tree::{NodeAction, NodeKind, TreeNode};
use serde::{Deserialize, Serialize};

/// One row in the tree as serialised to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDto {
    /// Stable id (matches [`TreeNode::id`]).
    pub id: String,
    /// Display label.
    pub label: String,
    /// `"section" | "repo" | "globalPath"`.
    pub kind: String,
    /// `true` for directories.
    pub is_dir: bool,
    /// Indent depth.
    pub depth: usize,
    /// Absolute filesystem path (empty for sections).
    pub path: String,
    /// Children in order. Sections list their leaves; leaves are empty.
    pub children: Vec<TreeNodeDto>,
    /// Repo only: bytes a `git clean -fxd` would reclaim.
    pub clean_size: Option<u64>,
    /// Repo only: total repo size on disk.
    pub delete_size: Option<u64>,
    /// Global only: total path size on disk.
    pub size: Option<u64>,
    /// Repo only: `true` once both sub-estimates have completed.
    pub size_done: bool,
}

impl From<&TreeNode> for TreeNodeDto {
    fn from(node: &TreeNode) -> Self {
        let kind = match node.kind {
            NodeKind::Section => "section",
            NodeKind::Repo => "repo",
            NodeKind::GlobalPath => "globalPath",
        };
        let status = node.repo_estimate_status.unwrap_or_default();
        TreeNodeDto {
            id: node.id.clone(),
            label: node.label.clone(),
            kind: kind.to_string(),
            is_dir: node.is_dir,
            depth: node.depth,
            path: node.path.to_string_lossy().to_string(),
            children: node.children.iter().map(TreeNodeDto::from).collect(),
            clean_size: node.clean_size,
            delete_size: node.delete_size,
            size: node.size,
            size_done: match node.kind {
                NodeKind::Repo => status.clean_done && status.delete_done,
                NodeKind::GlobalPath => node.size_done,
                NodeKind::Section => true,
            },
        }
    }
}

/// Result returned by `cleaner_scan_folder`. Holds the folder + the
/// pre-built section list. Repo size estimates and global sizes stream
/// in afterwards via `cleaner:size-update` events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResultDto {
    /// Absolute folder path that was scanned.
    pub folder: String,
    /// Number of repos discovered (cheap header-counter for the UI).
    pub repo_count: usize,
    /// Section/leaf rows. Always present, even when empty.
    pub roots: Vec<TreeNodeDto>,
}

/// Pre-discovered global cache section returned by `cleaner_discover_globals`.
/// Sized lazily as the user scrolls the tree (or in bulk after first scan).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalsSectionDto {
    /// Single section root with `kind == "section"` and global-path children.
    pub section: TreeNodeDto,
}

/// Streaming size update emitted by the size-estimation worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeUpdateDto {
    /// Originating scan id (matches the `scan_id` the frontend supplied
    /// when it called `cleaner_scan_folder`).  `"globals"` for global
    /// section updates.
    pub scan_id: String,
    /// Node id this update applies to (matches [`TreeNodeDto::id`]).
    pub node_id: String,
    /// Repo only: bytes reclaimable via `git clean -fxd`.
    pub clean_size: Option<u64>,
    /// Repo only: total repo size.
    pub delete_size: Option<u64>,
    /// Global only: total path size.
    pub size: Option<u64>,
    /// `true` once the estimator finished — even when the resulting size
    /// is `None` (i.e. the path has become inaccessible).
    pub done: bool,
}

/// Progress envelope for size estimation, emitted as `cleaner:size-progress`.
///
/// Lets the UI render an `estimating X/Y` counter à la the reference TUI:
/// the user can see at a glance how much work remains while still watching
/// individual rows light up via `cleaner:size-update`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeProgressDto {
    /// Originating scan id (the folder path, or `"globals"`).
    pub scan_id: String,
    /// How many size estimates have completed so far.
    pub completed: usize,
    /// Total number of estimates in this run.
    pub total: usize,
    /// `true` on the very last emission of a run (so the UI can switch
    /// the indicator off without polling).
    pub done: bool,
}

/// Action kind requested by `cleaner_run_actions`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunActionKind {
    /// `git clean -fxd` (repo only).
    Clean,
    /// `rm -rf` (repo or global path).
    Delete,
}

impl RunActionKind {
    /// Convert the wire kind into a [`NodeAction`] discriminant.
    pub fn as_node_action(self) -> NodeAction {
        match self {
            Self::Clean => NodeAction::Clean,
            Self::Delete => NodeAction::Delete,
        }
    }
}

/// One pending action submitted by the frontend run-confirm dialog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunActionItem {
    /// `"repo"` or `"globalPath"`.
    pub kind: String,
    /// Display label (used in result messages).
    pub label: String,
    /// Absolute path the action targets.
    pub path: String,
    /// Action to perform.
    pub action: RunActionKind,
}

/// Single failure entry in [`RunResultDto`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFailureDto {
    /// Display label of the command (e.g. `[clean] /a/b`).
    pub item: String,
    /// Human-readable error returned by `git`/`rm`.
    pub error: String,
}

/// Aggregate result of one bulk-run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResultDto {
    /// Commands that completed without error (display labels).
    pub successes: Vec<String>,
    /// Commands that failed, with their error messages.
    pub failures: Vec<RunFailureDto>,
}
