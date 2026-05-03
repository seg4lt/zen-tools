//! Tauri command surface for the per-request run history.
//!
//! The actual ring-buffer + persistence logic lives in `zen-runs`; this
//! module just resolves the canonical on-disk path
//! (`<app_data_dir>/runs.json`) and wraps the engine in Tauri commands.

use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub use zen_runs::{
    RunHistory, RunHistoryEntry, RunOutcome, MAX_BODY_BYTES, MAX_RUNS_PER_REQUEST,
};

fn runs_file(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("runs.json"))
}

/// Read the persisted ring buffers from disk into the in-memory state.
/// Called once at app startup.
pub fn load_runs(app: &AppHandle, store: &mut RunHistory) {
    let path = match runs_file(app) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(?e, "resolve runs.json path");
            return;
        }
    };
    zen_runs::load_from_disk(&path, store);
}

fn save_runs(app: &AppHandle, store: &RunHistory) -> AppResult<()> {
    let path = runs_file(app)?;
    zen_runs::save_to_disk(&path, store)
        .map_err(|e| AppError::Other(format!("save runs.json: {e}")))
}

// ────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────

/// Append a run to the history for `request_id`. Truncates the body
/// to [`MAX_BODY_BYTES`] and drops the oldest entry when the per-
/// request cap is reached. Persists to disk before returning.
#[tauri::command]
pub async fn record_run(
    request_id: String,
    entry: RunHistoryEntry,
    app: AppHandle,
    store: tauri::State<'_, Mutex<RunHistory>>,
) -> AppResult<()> {
    {
        let mut s = store.lock().await;
        s.record(request_id, entry);
        if let Err(e) = save_runs(&app, &s) {
            tracing::warn!(?e, "failed to persist runs.json");
        }
    }
    Ok(())
}

/// Return the in-memory history for the given request, oldest first.
#[tauri::command]
pub async fn get_run_history(
    request_id: String,
    store: tauri::State<'_, Mutex<RunHistory>>,
) -> AppResult<Vec<RunHistoryEntry>> {
    Ok(store.lock().await.get(&request_id))
}

/// Clear the history for one request when `request_id` is provided,
/// or *every* request when `None`. Persists to disk after the change.
#[tauri::command]
pub async fn clear_run_history(
    request_id: Option<String>,
    app: AppHandle,
    store: tauri::State<'_, Mutex<RunHistory>>,
) -> AppResult<()> {
    let mut s = store.lock().await;
    match request_id {
        Some(id) => s.clear_request(&id),
        None => s.clear_all(),
    }
    if let Err(e) = save_runs(&app, &s) {
        tracing::warn!(?e, "failed to persist runs.json");
    }
    Ok(())
}
