//! Per-request run history for the HTTP runner tool.
//!
//! Keeps the last [`MAX_RUNS_PER_REQUEST`] outcomes for every request
//! the user has executed, with optional disk persistence via
//! [`load_from_disk`] / [`save_to_disk`]. The Sent / Body / Headers /
//! Diff tabs all read from this store so the user can flip between
//! recent runs and compare them.
//!
//! The crate is host-agnostic: it doesn't know about Tauri,
//! `app_data_dir`, or any specific runtime. Callers pass a `&Path` for
//! persistence and decide where the file lives.
//!
//! Bodies are truncated to [`MAX_BODY_BYTES`] when recorded so a
//! megabyte-sized response doesn't blow up the on-disk file.

#![warn(missing_docs)]

use std::collections::VecDeque;
use std::path::Path;

use ahash::HashMap;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Number of runs retained per request (FIFO ring buffer).
pub const MAX_RUNS_PER_REQUEST: usize = 10;
/// Bodies larger than this are truncated when recorded; the entry
/// flags itself with `body_truncated: true`.
pub const MAX_BODY_BYTES: usize = 256 * 1024;

/// Errors raised by [`save_to_disk`] / [`load_from_disk`].
#[derive(Debug, Error)]
pub enum RunsError {
    /// Filesystem I/O error.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// JSON serialisation / deserialisation error.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Convenience alias.
pub type RunsResult<T> = std::result::Result<T, RunsError>;

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

/// Mutable in-memory store. Callers wrap this in their own mutex /
/// `tauri::State` etc.
#[derive(Debug, Default)]
pub struct RunHistory {
    /// `request_id → most-recent-last`.
    by_request: HashMap<String, VecDeque<RunHistoryEntry>>,
}

impl RunHistory {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a new run for the given request, dropping the oldest if
    /// we'd exceed the cap. Truncates oversized bodies in-place.
    pub fn record(&mut self, request_id: String, mut entry: RunHistoryEntry) {
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

/// Read the persisted ring buffers from `path` into `store`. Missing
/// files are treated as empty history (no error). Parse failures are
/// logged via `tracing` and the store is left untouched.
pub fn load_from_disk(path: &Path, store: &mut RunHistory) {
    if !path.exists() {
        return;
    }
    match std::fs::read_to_string(path) {
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
/// leave a half-written file behind.
pub fn save_to_disk(path: &Path, store: &RunHistory) -> RunsResult<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string(&store.snapshot())?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> RunHistoryEntry {
        RunHistoryEntry {
            timestamp: Local::now(),
            outcome: RunOutcome::Success,
            method: "GET".into(),
            url: "https://example.com".into(),
            status_code: Some(200),
            status_text: Some("OK".into()),
            duration_ms: Some(12.0),
            size_bytes: Some(0),
            body: String::new(),
            body_truncated: false,
            headers: Vec::new(),
            extracted_vars: HashMap::default(),
            error_message: None,
        }
    }

    #[test]
    fn record_truncates_oversized_bodies() {
        let mut store = RunHistory::new();
        let mut e = entry();
        e.body = "x".repeat(MAX_BODY_BYTES + 100);
        store.record("r1".into(), e);
        let got = store.get("r1");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].body.len(), MAX_BODY_BYTES);
        assert!(got[0].body_truncated);
    }

    #[test]
    fn record_drops_oldest_at_cap() {
        let mut store = RunHistory::new();
        for i in 0..(MAX_RUNS_PER_REQUEST + 5) {
            let mut e = entry();
            e.url = format!("https://example.com/{i}");
            store.record("r1".into(), e);
        }
        let got = store.get("r1");
        assert_eq!(got.len(), MAX_RUNS_PER_REQUEST);
        // Oldest entry should be `i = 5` (we recorded MAX+5 total).
        assert!(got[0].url.ends_with("/5"));
    }

    #[test]
    fn replace_trims_excess_per_request_lists() {
        let mut store = RunHistory::new();
        let mut snapshot = HashMap::default();
        snapshot.insert(
            "r1".to_string(),
            (0..(MAX_RUNS_PER_REQUEST + 3)).map(|_| entry()).collect(),
        );
        store.replace(snapshot);
        assert_eq!(store.get("r1").len(), MAX_RUNS_PER_REQUEST);
    }
}
