//! In-memory registry of running / recently-finished review runs.
//!
//! The registry is the source of truth while a Claude child is alive.
//! It carries the cancellation handle, the live event log (so a
//! frontend that re-mounts mid-run can replay everything it missed),
//! and the per-PR keyed slot we use to reject "already running"
//! collisions.
//!
//! When a run finishes, [`persist::record_completion`] writes its
//! final state to the SQLite KvStore so a fresh process can still
//! show the user the previous report — the registry can drop the
//! entry.

use std::sync::Arc;

use ahash::HashMap;
use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::events::AiReviewEvent;

/// Status of a review run as the registry sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Worktree prep / Claude spawn in flight.
    Starting,
    /// Claude is actively producing events.
    Running,
    /// Claude exited successfully and the report has been persisted.
    Done,
    /// Claude exited non-zero, was cancelled, or timed out.
    Error,
    /// User cancelled before completion.
    Cancelled,
}

/// Stable per-PR identity used to dedupe concurrent runs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PrKey {
    /// Repo owner.
    pub owner: String,
    /// Repo name.
    pub repo: String,
    /// PR number.
    pub number: u64,
}

impl PrKey {
    /// Format as `owner/repo#number` — the canonical persisted form.
    pub fn slug(&self) -> String {
        format!("{}/{}#{}", self.owner, self.repo, self.number)
    }
}

/// A single live or recently-completed review run.
#[derive(Debug, Clone)]
pub struct RunEntry {
    /// Run id (UUID v4 string).
    pub run_id: String,
    /// PR identity.
    pub pr: PrKey,
    /// Head SHA we're reviewing.
    pub head_sha: String,
    /// Worktree path (for cleanup + diagnostics).
    pub worktree_path: String,
    /// Resolved Claude model.
    pub model: String,
    /// UNIX-millis when the run started.
    pub started_at_ms: i64,
    /// UNIX-millis when the run finished, or `None` while live.
    pub finished_at_ms: Option<i64>,
    /// Latest known status.
    pub status: RunStatus,
    /// Buffered events, in arrival order.
    pub events: Vec<AiReviewEvent>,
    /// Path on disk to the persisted HTML report once `status == Done`.
    pub report_path: Option<String>,
    /// Reported cost in USD when the CLI exposed one.
    pub cost_usd: Option<f64>,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: Option<u64>,
}

/// Cheap-to-clone registry handle (`Arc`).
#[derive(Debug, Clone, Default)]
pub struct RunRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    /// All runs we know about, keyed by `run_id`.
    runs: HashMap<String, RunEntry>,
    /// Maps `(pr_slug, head_sha)` → `run_id` for the currently-live run
    /// matching that pair, used to enforce "only one active review per
    /// (PR, head sha)".
    live_keys: HashMap<(String, String), String>,
    /// Maps `run_id` → cancel handle (`AbortHandle`-style closure).
    /// We keep a `tokio::sync::Notify` per run; cancelling fires it,
    /// which the runner observes via `tokio::select!`.
    cancels: HashMap<String, Arc<tokio::sync::Notify>>,
}

impl RunRegistry {
    /// Build an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocate a new `run_id` and register it as `Starting` for the
    /// given `(pr, head_sha)`. Returns the run id and the cancel
    /// notifier the runner should listen on.
    pub fn start(
        &self,
        pr: PrKey,
        head_sha: String,
        worktree_path: String,
        model: String,
    ) -> Result<(String, Arc<tokio::sync::Notify>), AlreadyLive> {
        let mut inner = self.inner.lock();
        let key = (pr.slug(), head_sha.clone());
        if inner.live_keys.contains_key(&key) {
            return Err(AlreadyLive);
        }
        let run_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(tokio::sync::Notify::new());
        inner.live_keys.insert(key, run_id.clone());
        inner.cancels.insert(run_id.clone(), cancel.clone());
        inner.runs.insert(
            run_id.clone(),
            RunEntry {
                run_id: run_id.clone(),
                pr,
                head_sha,
                worktree_path,
                model,
                started_at_ms: Utc::now().timestamp_millis(),
                finished_at_ms: None,
                status: RunStatus::Starting,
                events: Vec::new(),
                report_path: None,
                cost_usd: None,
                duration_ms: None,
            },
        );
        Ok((run_id, cancel))
    }

    /// Append an event to the run's buffered log. No-op for unknown
    /// run ids (the run was already evicted).
    pub fn append_event(&self, run_id: &str, event: AiReviewEvent) {
        let mut inner = self.inner.lock();
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry.events.push(event);
            if entry.status == RunStatus::Starting {
                entry.status = RunStatus::Running;
            }
        }
    }

    /// Mark the run as finished with the given status. Returns the
    /// final entry (cloned) so the caller can hand it to the persistence
    /// layer.
    pub fn finish(
        &self,
        run_id: &str,
        status: RunStatus,
        report_path: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    ) -> Option<RunEntry> {
        let mut inner = self.inner.lock();
        let entry = inner.runs.get_mut(run_id)?;
        entry.status = status;
        entry.finished_at_ms = Some(Utc::now().timestamp_millis());
        if let Some(path) = report_path {
            entry.report_path = Some(path);
        }
        entry.cost_usd = cost_usd;
        entry.duration_ms = duration_ms;
        let snapshot = entry.clone();
        let key = (snapshot.pr.slug(), snapshot.head_sha.clone());
        inner.live_keys.remove(&key);
        inner.cancels.remove(run_id);
        Some(snapshot)
    }

    /// Snapshot of a single run for re-attach.
    pub fn snapshot(&self, run_id: &str) -> Option<RunEntry> {
        self.inner.lock().runs.get(run_id).cloned()
    }

    /// Trigger cancellation for `run_id`. The runner is listening on
    /// the same `Notify`. Returns `true` when the run existed.
    pub fn cancel(&self, run_id: &str) -> bool {
        let cancel = self.inner.lock().cancels.get(run_id).cloned();
        match cancel {
            Some(n) => {
                n.notify_waiters();
                true
            }
            None => false,
        }
    }

    /// Drop a run from the in-memory map (after persisting it).
    pub fn evict(&self, run_id: &str) {
        let mut inner = self.inner.lock();
        if let Some(entry) = inner.runs.remove(run_id) {
            let key = (entry.pr.slug(), entry.head_sha.clone());
            inner.live_keys.remove(&key);
        }
        inner.cancels.remove(run_id);
    }
}

/// Returned by [`RunRegistry::start`] when a duplicate review for the
/// same `(pr, head_sha)` is already live.
#[derive(Debug, Clone, Copy)]
pub struct AlreadyLive;

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64) -> PrKey {
        PrKey {
            owner: "octo".into(),
            repo: "demo".into(),
            number: n,
        }
    }

    #[test]
    fn start_rejects_duplicate_pr_sha_pair() {
        let reg = RunRegistry::new();
        let _ = reg
            .start(pr(1), "abc".into(), "/tmp/x".into(), "sonnet".into())
            .unwrap();
        let dup = reg.start(pr(1), "abc".into(), "/tmp/x".into(), "sonnet".into());
        assert!(dup.is_err());
    }

    #[test]
    fn finish_clears_live_key() {
        let reg = RunRegistry::new();
        let (run_id, _) = reg
            .start(pr(2), "abc".into(), "/tmp/x".into(), "sonnet".into())
            .unwrap();
        reg.finish(&run_id, RunStatus::Done, Some("/tmp/r.html".into()), Some(0.1), Some(2000))
            .unwrap();
        // Same PR + sha can run again now.
        assert!(reg
            .start(pr(2), "abc".into(), "/tmp/y".into(), "sonnet".into())
            .is_ok());
    }

    #[test]
    fn append_event_promotes_starting_to_running() {
        let reg = RunRegistry::new();
        let (run_id, _) = reg
            .start(pr(3), "abc".into(), "/tmp/x".into(), "sonnet".into())
            .unwrap();
        reg.append_event(&run_id, AiReviewEvent::Stdout { line: "hi".into() });
        let snap = reg.snapshot(&run_id).unwrap();
        assert_eq!(snap.status, RunStatus::Running);
        assert_eq!(snap.events.len(), 1);
    }
}
