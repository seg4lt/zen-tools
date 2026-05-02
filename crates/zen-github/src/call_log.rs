//! Rolling FIFO log of `gh` invocations powering the **API Stats** tab.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Maximum number of entries kept in the rolling log. Matches the Swift
/// `GitHubService.maxLogEntries = 100`.
const MAX_ENTRIES: usize = 100;

/// One captured `gh` invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhCall {
    /// Wall-clock time the call was recorded.
    pub timestamp: DateTime<Utc>,
    /// Human-readable label (e.g. `"search prs --review-requested @me"`).
    pub command: String,
    /// How long the child process took, in milliseconds (with sub-ms fraction).
    pub duration_ms: f64,
    /// Whether the child exited 0.
    pub success: bool,
}

impl GhCall {
    /// Build a new entry from the given parts.
    pub fn new(command: impl Into<String>, duration: Duration, success: bool) -> Self {
        Self {
            timestamp: Utc::now(),
            command: command.into(),
            duration_ms: duration.as_secs_f64() * 1000.0,
            success,
        }
    }
}

/// Bounded FIFO log shared across the engine and the API Stats tab.
#[derive(Debug, Default, Clone)]
pub struct CallLog {
    inner: Arc<Mutex<CallLogInner>>,
}

#[derive(Debug, Default)]
struct CallLogInner {
    entries: VecDeque<GhCall>,
    total: u64,
    session: u64,
}

impl CallLog {
    /// Record a new call and increment the running counters.
    pub fn record(&self, call: GhCall) {
        let mut g = self.inner.lock();
        if call.success {
            // counted regardless — matches the Swift behaviour of bumping both
            // counters before recording success/failure.
        }
        g.total += 1;
        g.session += 1;
        g.entries.push_back(call);
        while g.entries.len() > MAX_ENTRIES {
            g.entries.pop_front();
        }
    }

    /// Snapshot the current entries (most recent last).
    pub fn snapshot(&self) -> Vec<GhCall> {
        let g = self.inner.lock();
        g.entries.iter().cloned().collect()
    }

    /// `(total, session, entries)` tuple matching the Swift `getStats()`.
    pub fn stats(&self) -> (u64, u64, Vec<GhCall>) {
        let g = self.inner.lock();
        (g.total, g.session, g.entries.iter().cloned().collect())
    }

    /// Reset the session counter (preserves the rolling log + total counter).
    pub fn reset_session(&self) {
        self.inner.lock().session = 0;
    }
}
