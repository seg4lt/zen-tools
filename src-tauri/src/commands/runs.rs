//! Per-request run history.
//!
//! Keeps the last [`MAX_RUNS_PER_REQUEST`] outcomes for every request the
//! user has executed, persisted to disk in the OS-specific app-data
//! directory. The Sent / Body / Headers / Diff tabs all read from this
//! store so the user can flip between recent runs and compare them.
//!
//! Storage: a single `runs.json` file alongside `preferences.json`.
//! Bodies are truncated to [`MAX_BODY_BYTES`] when recorded so a
//! megabyte-sized response doesn't blow up the file.

use crate::error::{AppError, AppResult};
use ahash::HashMap;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Number of runs retained per request (FIFO ring buffer).
pub const MAX_RUNS_PER_REQUEST: usize = 10;
/// Bodies larger than this are truncated when recorded; the entry
/// flags itself with `bodyTruncated: true`.
pub const MAX_BODY_BYTES: usize = 256 * 1024;

/// One captured run. Mirrors the chunks of `RequestResult` the UI
/// actually wants to revisit, with timestamps + a normalised body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryEntry {
    /// Wall-clock completion time.
    pub timestamp: DateTime<Local>,
    /// `success` | `error`.
    pub outcome: RunOutcome,
    /// `GET` / `POST` / etc.
    pub method: String,
    /// Resolved URL the request hit (or attempted).
    pub url: String,
    /// HTTP status code (success only).
    pub status_code: Option<u16>,
    /// HTTP status text (success only).
    pub status_text: Option<String>,
    /// Response duration in milliseconds.
    pub duration_ms: Option<f64>,
    /// Body bytes on the wire (before truncation).
    pub size_bytes: Option<usize>,
    /// Response body (potentially truncated).
    pub body: String,
    /// `true` when the body was truncated to fit `MAX_BODY_BYTES`.
    pub body_truncated: bool,
    /// Response headers (in wire order, dup-name preserved).
    pub headers: Vec<(String, String)>,
    /// Extracted vars at the time of the run.
    pub extracted_vars: HashMap<String, String>,
    /// Error message on failure.
    pub error_message: Option<String>,
}

/// Categorical outcome of a captured run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunOutcome {
    /// Server returned a complete response (any HTTP status code).
    Success,
    /// Transport-level failure (DNS, connect, TLS, body read, …).
    Error,
}

/// Mutable in-memory store. Wrapped in a `tokio::Mutex` and shared via
/// Tauri state — write-on-record, read-on-view.
#[derive(Debug, Default)]
pub struct RunHistory {
    /// `request_id → most-recent-last`.
    by_request: HashMap<String, VecDeque<RunHistoryEntry>>,
}

impl RunHistory {
    /// Push a new run for the given request, dropping the oldest if
    /// we'd exceed the cap.
    pub fn record(&mut self, request_id: String, mut entry: RunHistoryEntry) {
        // Truncate the body if it's too large to persist comfortably.
        if entry.body.len() > MAX_BODY_BYTES {
            entry.body.truncate(MAX_BODY_BYTES);
            entry.body_truncated = true;
        }
        let queue = self.by_request.entry(request_id).or_default();
        if queue.len() >= MAX_RUNS_PER_REQUEST {
            queue.pop_front();
        }
        queue.push_back(entry);
    }

    /// Read-only access to a request's history (oldest first).
    pub fn get(&self, request_id: &str) -> Vec<RunHistoryEntry> {
        self.by_request
            .get(request_id)
            .map(|q| q.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop all history for a single request.
    pub fn clear_request(&mut self, request_id: &str) {
        self.by_request.remove(request_id);
    }

    /// Drop everything.
    pub fn clear_all(&mut self) {
        self.by_request.clear();
    }

    /// Materialise a flat `HashMap` for serialisation.
    pub fn snapshot(&self) -> HashMap<String, Vec<RunHistoryEntry>> {
        self.by_request
            .iter()
            .map(|(k, q)| (k.clone(), q.iter().cloned().collect()))
            .collect()
    }

    /// Replace the entire store from a snapshot (loaded from disk).
    /// Trims any per-request lists exceeding the cap defensively.
    pub fn replace(&mut self, snapshot: HashMap<String, Vec<RunHistoryEntry>>) {
        self.by_request = snapshot
            .into_iter()
            .map(|(k, v)| {
                let mut q: VecDeque<_> = v.into();
                while q.len() > MAX_RUNS_PER_REQUEST {
                    q.pop_front();
                }
                (k, q)
            })
            .collect();
    }
}

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
    if !path.exists() {
        return;
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<HashMap<String, Vec<RunHistoryEntry>>>(
            &content,
        ) {
            Ok(snapshot) => store.replace(snapshot),
            Err(e) => {
                tracing::warn!(?e, path = %path.display(), "runs.json parse failed; ignoring");
            }
        },
        Err(e) => tracing::warn!(?e, path = %path.display(), "runs.json read failed"),
    }
}

/// Atomic write — temp file + rename — so a crash mid-write can't
/// leave a half-written runs.json behind.
fn save_runs(app: &AppHandle, store: &RunHistory) -> AppResult<()> {
    let path = runs_file(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(&store.snapshot())?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
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
