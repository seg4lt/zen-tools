//! Disk-space cleaner library.
//!
//! Three concerns:
//! - [`git`]: parallel discovery of git repository roots beneath a folder.
//! - [`deletion`]: dev-tool cache discovery, size estimation, and the
//!   `git clean` / `rm -rf` execution layer.
//! - [`tree`]: presentation-tree data model the UI binds against.
//! - [`dto`]: serialisable IPC mirrors of [`tree`] for the Tauri layer.
//!
//! All UI-agnostic — ported verbatim from the standalone `cleaner` ratatui
//! app and re-shaped to be embeddable inside the Tauri runtime.

#![warn(missing_docs)]

pub mod deletion;
pub mod dto;
pub mod git;
pub mod tree;

pub use deletion::{
    discover_global_cleanup_targets, estimate_path_size, estimate_repo_savings, run_repo_command,
    run_repo_commands, GlobalCleanupTarget, RepoCommand, RepoCommandKind, RepoSavingsEstimate,
};
pub use dto::{
    GlobalsSectionDto, RunActionItem, RunActionKind, RunFailureDto, RunResultDto, ScanResultDto,
    SizeProgressDto, SizeUpdateDto, TreeNodeDto,
};
pub use git::{find_git_repos, find_git_repos_streaming};
pub use tree::{
    format_size, GlobalTreeEntry, NodeAction, NodeKind, RepoEstimateStatus, Tree, TreeNode,
};
