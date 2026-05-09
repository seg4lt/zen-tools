//! Tauri command surface for the **Git** tool (merge editor + commit log).
//!
//! All commands proxy to [`zen_git::GitEngine`] held inside [`AppState`].
//! The engine is `Arc`-backed and cheap to clone — every handler clones
//! it out from under the outer `Mutex<AppState>` lock and drops the
//! lock before awaiting any git work.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;

use zen_git::{
    BranchRef, Commit, CommitLogFilter, ConflictBlobs, ConflictFile, FileChange, FileDiff,
    GitEngine, MergePreview, MergeState, RepoEntry,
};

use crate::error::AppResult;
use crate::state::AppState;

fn engine(state: &AppState) -> GitEngine {
    state.git.clone()
}

// ──────────────────────────────────────────────────────────────────────────
// Repo registry
// ──────────────────────────────────────────────────────────────────────────

/// All repos the user has registered with the Git tool.
#[tauri::command]
pub async fn git_list_repos(
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Vec<RepoEntry>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.list_repos().await)
}

/// Add a repo to the registry by absolute path.
#[tauri::command]
pub async fn git_add_repo(
    state: State<'_, Mutex<AppState>>,
    path: String,
    label: Option<String>,
) -> AppResult<RepoEntry> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.add_repo(PathBuf::from(path), label).await?)
}

/// Open a native folder picker; if the user picked a folder, register
/// it as a repo and return the new entry. Returns `None` on cancel.
#[tauri::command]
pub async fn git_pick_and_add_repo(
    app_handle: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<Option<RepoEntry>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });

    let folder = match rx.await {
        Ok(Some(f)) => f.to_string(),
        _ => return Ok(None),
    };

    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(Some(eng.add_repo(PathBuf::from(folder), None).await?))
}

/// Remove a repo from the registry.
#[tauri::command]
pub async fn git_remove_repo(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.remove_repo(PathBuf::from(path)).await?;
    Ok(())
}

/// Rename the display label of a registered repo.
#[tauri::command]
pub async fn git_relabel_repo(
    state: State<'_, Mutex<AppState>>,
    path: String,
    label: String,
) -> AppResult<bool> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.relabel_repo(PathBuf::from(path), label).await?)
}

// ──────────────────────────────────────────────────────────────────────────
// Commit log
// ──────────────────────────────────────────────────────────────────────────

/// `git log` with the IntelliJ-style filter applied.
#[tauri::command]
pub async fn git_list_commits(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    filter: CommitLogFilter,
) -> AppResult<Vec<Commit>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.list_commits(&PathBuf::from(repo), &filter).await?)
}

/// Total number of commits matching `filter` (no skip / limit).
#[tauri::command]
pub async fn git_count_commits(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    filter: CommitLogFilter,
) -> AppResult<u32> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.count_commits(&PathBuf::from(repo), &filter).await?)
}

/// Branch refs (local + remote) for the branch dropdown.
#[tauri::command]
pub async fn git_list_branches(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<Vec<BranchRef>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.list_branches(&PathBuf::from(repo)).await?)
}

/// Distinct authors for the author-filter dropdown.
#[tauri::command]
pub async fn git_list_authors(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    limit: Option<u32>,
) -> AppResult<Vec<String>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng
        .list_authors(&PathBuf::from(repo), limit.unwrap_or(500))
        .await?)
}

// ──────────────────────────────────────────────────────────────────────────
// Commit details
// ──────────────────────────────────────────────────────────────────────────

/// Files changed by `rev`.
#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    rev: String,
) -> AppResult<Vec<FileChange>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.commit_files(&PathBuf::from(repo), &rev).await?)
}

/// Per-file unified diff at `rev`.
#[tauri::command]
pub async fn git_commit_diff(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    rev: String,
    path: String,
) -> AppResult<FileDiff> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng
        .commit_diff_file(&PathBuf::from(repo), &rev, &path)
        .await?)
}

/// File contents at `rev` (for the 2-way diff viewer in the commit pane).
#[tauri::command]
pub async fn git_file_at_rev(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    rev: String,
    path: String,
) -> AppResult<String> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng
        .file_at_rev(&PathBuf::from(repo), &rev, &path)
        .await?)
}

// ──────────────────────────────────────────────────────────────────────────
// Merge state / conflicts / ops
// ──────────────────────────────────────────────────────────────────────────

/// In-progress operation snapshot (merge / rebase / cherry-pick / revert / none).
#[tauri::command]
pub async fn git_merge_state(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<MergeState> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.merge_state(&PathBuf::from(repo)).await?)
}

/// Every conflicting path the index currently holds.
#[tauri::command]
pub async fn git_list_conflicts(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<Vec<ConflictFile>> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.list_conflicts(&PathBuf::from(repo)).await?)
}

/// 3-blob payload (base / local / remote / working) for a single conflict.
#[tauri::command]
pub async fn git_conflict_blobs(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    path: String,
) -> AppResult<ConflictBlobs> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng.conflict_blobs(&PathBuf::from(repo), &path).await?)
}

/// Write `content` into `<repo>/<path>` and stage it.
#[tauri::command]
pub async fn git_write_resolved(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    path: String,
    content: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.write_resolved(&PathBuf::from(repo), &path, &content)
        .await?;
    Ok(())
}

/// `git add -- <path>`.
#[tauri::command]
pub async fn git_stage_path(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    path: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.stage_path(&PathBuf::from(repo), &path).await?;
    Ok(())
}

/// `git restore --staged -- <path>`.
#[tauri::command]
pub async fn git_unstage_path(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    path: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.unstage_path(&PathBuf::from(repo), &path).await?;
    Ok(())
}

/// Trial-merge `from` into `into` without touching the worktree.
#[tauri::command]
pub async fn git_preview_merge(
    state: State<'_, Mutex<AppState>>,
    repo: String,
    into: String,
    from: String,
) -> AppResult<MergePreview> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    Ok(eng
        .preview_merge(&PathBuf::from(repo), &into, &from)
        .await?)
}

/// Continue the in-progress operation (merge / rebase / cherry-pick / revert).
#[tauri::command]
pub async fn git_continue_op(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.continue_op(&PathBuf::from(repo)).await?;
    Ok(())
}

/// Abort the in-progress operation.
#[tauri::command]
pub async fn git_abort_op(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.abort_op(&PathBuf::from(repo)).await?;
    Ok(())
}

/// Skip the current step (rebase / cherry-pick / revert only).
#[tauri::command]
pub async fn git_skip_op(
    state: State<'_, Mutex<AppState>>,
    repo: String,
) -> AppResult<()> {
    let eng = {
        let s = state.lock().await;
        engine(&s)
    };
    eng.skip_op(&PathBuf::from(repo)).await?;
    Ok(())
}
