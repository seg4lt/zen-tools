//! Stop-signal handle for performance tests.
//!
//! Replaces the original `Arc<AtomicBool>` with a `tokio::sync::watch`
//! channel so worker tasks fan out the signal in O(1) without polling.

use tokio::sync::watch;

/// Owner-side stop signal for a running perf test.
///
/// Each spawned worker subscribes once and `await`s the receiver — calling
/// [`StopHandle::stop`] wakes them all immediately.
#[derive(Debug)]
pub struct StopHandle {
    tx: watch::Sender<bool>,
}

impl Default for StopHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl StopHandle {
    /// Create a fresh handle in the "running" state.
    pub fn new() -> Self {
        let (tx, _) = watch::channel(false);
        Self { tx }
    }

    /// Subscribe a new worker to the signal.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }

    /// Signal all subscribers to stop.
    pub fn stop(&self) {
        let _ = self.tx.send(true);
    }

    /// Has stop been signalled?
    pub fn is_stopped(&self) -> bool {
        *self.tx.borrow()
    }
}
