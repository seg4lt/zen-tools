//! Domain controller for the **Git** zen-tools app.
//!
//! [`GitEngine`] is the single point of orchestration the Tauri command
//! layer talks to. It owns:
//!
//! * A [`zen_shell::ShellExecutor`] pre-configured for `git` calls
//!   (PATH-augmented, 5-minute timeout to accommodate large-history
//!   `git log -G` / `-S` walks).
//! * A persisted multi-repo registry (`<config_dir>/repos.json`) the
//!   frontend's sidebar reads from and mutates via add / remove /
//!   relabel.
//!
//! Every method is `async`, never blocks the runtime, and returns
//! [`GitResult`] so callers can distinguish missing-binary, exit-failure,
//! timeout, and registry-I/O errors via [`GitError`].
//!
//! Cheap to clone — the engine is `Arc`-backed so the Tauri command
//! handlers can `.clone()` it out from under the outer `Mutex<AppState>`
//! lock and drop the lock before awaiting any git work.

#![warn(missing_docs)]

pub mod conflict;
pub mod diff;
pub mod error;
pub mod log;
pub mod merge_ops;
pub mod merge_state;
pub mod models;
pub mod repos;
pub mod shell;

pub use error::{GitError, GitResult};
pub use models::{
    BranchRef, Commit, CommitLogFilter, ConflictBlobs, ConflictFile, ConflictStatus, FileChange,
    FileChangeStatus, FileDiff, MergeKind, MergePreview, MergeState, RepoEntry, TextScope,
    TextSearch,
};

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::RwLock;
use zen_shell::ShellExecutor;

/// Cheap-to-clone (`Arc`) handle wrapping a [`ShellExecutor`] and the
/// persisted repo registry.
#[derive(Debug, Clone)]
pub struct GitEngine {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    exec: ShellExecutor,
    repos: RwLock<repos::RepoRegistry>,
    config_dir: PathBuf,
}

impl GitEngine {
    /// Build an engine using [`repos::default_config_dir`].
    pub fn new() -> Self {
        Self::with_config_dir(repos::default_config_dir())
    }

    /// Build an engine that persists its registry under `config_dir`.
    pub fn with_config_dir(config_dir: PathBuf) -> Self {
        let registry = repos::RepoRegistry::load(&config_dir).unwrap_or_default();
        Self {
            inner: Arc::new(Inner {
                exec: shell::build_executor(),
                repos: RwLock::new(registry),
                config_dir,
            }),
        }
    }

    /// Snapshot of the currently tracked repos.
    pub async fn list_repos(&self) -> Vec<RepoEntry> {
        self.inner.repos.read().await.list()
    }

    /// Add a repo to the registry. Validates the path is a git working
    /// tree and persists the change.
    pub async fn add_repo(
        &self,
        path: PathBuf,
        label: Option<String>,
    ) -> GitResult<RepoEntry> {
        shell::ensure_repo(&self.inner.exec, &path).await?;
        let entry = {
            let mut g = self.inner.repos.write().await;
            let entry = g.add(&path, label);
            g.save(&self.inner.config_dir)?;
            entry
        };
        Ok(entry)
    }

    /// Remove a repo from the registry. No-op if not present.
    pub async fn remove_repo(&self, path: PathBuf) -> GitResult<()> {
        let mut g = self.inner.repos.write().await;
        g.remove(&path);
        g.save(&self.inner.config_dir)?;
        Ok(())
    }

    /// Update the display label of a repo. Returns `false` when no
    /// matching entry was found.
    pub async fn relabel_repo(&self, path: PathBuf, label: String) -> GitResult<bool> {
        let mut g = self.inner.repos.write().await;
        let changed = g.set_label(&path, label);
        if changed {
            g.save(&self.inner.config_dir)?;
        }
        Ok(changed)
    }

    // ── Log ──────────────────────────────────────────────────────────

    /// `git log` with the IntelliJ-style filter applied.
    pub async fn list_commits(
        &self,
        repo: &Path,
        filter: &CommitLogFilter,
    ) -> GitResult<Vec<Commit>> {
        log::list_commits(&self.inner.exec, repo, filter).await
    }

    /// Total commit count matching `filter` (no skip / limit).
    pub async fn count_commits(
        &self,
        repo: &Path,
        filter: &CommitLogFilter,
    ) -> GitResult<u32> {
        log::count_commits(&self.inner.exec, repo, filter).await
    }

    /// Distinct authors for the author-filter dropdown.
    pub async fn list_authors(&self, repo: &Path, limit: u32) -> GitResult<Vec<String>> {
        log::list_authors(&self.inner.exec, repo, limit).await
    }

    /// All branches (local + remote) with tip SHA.
    pub async fn list_branches(&self, repo: &Path) -> GitResult<Vec<BranchRef>> {
        log::list_branches(&self.inner.exec, repo).await
    }

    // ── Diff ─────────────────────────────────────────────────────────

    /// Files changed by `rev`.
    pub async fn commit_files(
        &self,
        repo: &Path,
        rev: &str,
    ) -> GitResult<Vec<FileChange>> {
        diff::commit_files(&self.inner.exec, repo, rev).await
    }

    /// Per-file unified diff at `rev`.
    pub async fn commit_diff_file(
        &self,
        repo: &Path,
        rev: &str,
        path: &str,
    ) -> GitResult<FileDiff> {
        diff::commit_diff_file(&self.inner.exec, repo, rev, path).await
    }

    /// Read a file's contents at `rev`.
    pub async fn file_at_rev(
        &self,
        repo: &Path,
        rev: &str,
        path: &str,
    ) -> GitResult<String> {
        diff::file_at_rev(&self.inner.exec, repo, rev, path).await
    }

    // ── Merge state / conflict / ops ─────────────────────────────────

    /// What kind of operation (if any) is in progress in this repo.
    pub async fn merge_state(&self, repo: &Path) -> GitResult<MergeState> {
        merge_state::detect(&self.inner.exec, repo).await
    }

    /// Every conflicting path the index currently holds.
    pub async fn list_conflicts(&self, repo: &Path) -> GitResult<Vec<ConflictFile>> {
        conflict::list_unmerged(&self.inner.exec, repo).await
    }

    /// 3-blob payload for a single conflicting path.
    pub async fn conflict_blobs(&self, repo: &Path, path: &str) -> GitResult<ConflictBlobs> {
        conflict::conflict_blobs(&self.inner.exec, repo, path).await
    }

    /// Trial-merge `from` into `into` without touching the worktree.
    pub async fn preview_merge(
        &self,
        repo: &Path,
        into: &str,
        from: &str,
    ) -> GitResult<MergePreview> {
        merge_ops::preview_merge(&self.inner.exec, repo, into, from).await
    }

    /// Write `content` to `path` and stage it.
    pub async fn write_resolved(
        &self,
        repo: &Path,
        path: &str,
        content: &str,
    ) -> GitResult<()> {
        merge_ops::write_resolved(&self.inner.exec, repo, path, content).await
    }

    /// `git add -- <path>`.
    pub async fn stage_path(&self, repo: &Path, path: &str) -> GitResult<()> {
        merge_ops::stage_path(&self.inner.exec, repo, path).await
    }

    /// `git restore --staged -- <path>`.
    pub async fn unstage_path(&self, repo: &Path, path: &str) -> GitResult<()> {
        merge_ops::unstage_path(&self.inner.exec, repo, path).await
    }

    /// Continue the in-progress operation.
    pub async fn continue_op(&self, repo: &Path) -> GitResult<()> {
        let s = self.merge_state(repo).await?;
        merge_ops::continue_op(&self.inner.exec, repo, s.kind).await
    }

    /// Abort the in-progress operation.
    pub async fn abort_op(&self, repo: &Path) -> GitResult<()> {
        let s = self.merge_state(repo).await?;
        merge_ops::abort_op(&self.inner.exec, repo, s.kind).await
    }

    /// Skip the current step (rebase / cherry-pick / revert only).
    pub async fn skip_op(&self, repo: &Path) -> GitResult<()> {
        let s = self.merge_state(repo).await?;
        merge_ops::skip_op(&self.inner.exec, repo, s.kind).await
    }
}

impl Default for GitEngine {
    fn default() -> Self {
        Self::new()
    }
}
