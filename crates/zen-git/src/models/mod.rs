//! Wire-level DTOs returned across the Tauri boundary. Every type
//! derives `Serialize`/`Deserialize` so the frontend can consume them
//! verbatim through `invoke<T>(…)`.

pub mod commit;
pub mod filter;
pub mod merge;
pub mod repo;

pub use commit::{BranchRef, Commit, FileChange, FileChangeStatus, FileDiff};
pub use filter::{CommitLogFilter, TextScope, TextSearch};
pub use merge::{
    ConflictBlobs, ConflictFile, ConflictStatus, MergeKind, MergePreview, MergeState,
};
pub use repo::RepoEntry;
