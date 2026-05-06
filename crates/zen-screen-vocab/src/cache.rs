//! Tiny TTL'd cache around [`crate::snapshot_vocab`].
//!
//! Why: rapid successive dictation triggers (tap-tap-tap on the
//! hotkey) shouldn't burn an OCR pass each time. The screen content
//! between two utterances 2 seconds apart is virtually always
//! identical, so we cache the last vocabulary list for a short
//! window.
//!
//! The cache is intentionally NOT keyed on screen contents — that
//! would require either a fingerprint of the captured frames (defeats
//! the purpose; we'd still pay for capture) or polling for display
//! change tokens (more code than this is worth). Pure time-based TTL
//! is good enough; the worst case is a stale list for a few hundred
//! ms after the user switches windows, which still helps recognition
//! of the previous context's vocabulary.
//!
//! Concurrency: a single `Mutex<Option<CachedSnapshot>>` is plenty —
//! the cache is touched once per dictation utterance, not on hot
//! paths.

use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::{snapshot_vocab, DEFAULT_MAX_TERMS};

/// Default TTL for cached snapshots. 5 seconds is long enough to
/// cover rapid retries, short enough that switching windows during
/// normal use produces fresh vocab.
pub const DEFAULT_TTL: Duration = Duration::from_secs(5);

/// Snapshot of the current screen's vocabulary, captured at `taken_at`.
#[derive(Debug, Clone)]
pub struct CachedSnapshot {
    /// When the OCR run finished. Used to age the cache out.
    pub taken_at: Instant,
    /// The ranked vocabulary list. Empty when OCR returned nothing
    /// (or wasn't permitted).
    pub vocab: Vec<String>,
}

/// TTL'd cache wrapping [`snapshot_vocab`]. Cheap to clone (one Arc
/// inside the `Mutex`).
#[derive(Default)]
pub struct VocabCache {
    inner: Mutex<Option<CachedSnapshot>>,
}

impl VocabCache {
    /// Construct an empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached vocabulary if it's still fresh, otherwise
    /// run a new snapshot, store it, and return that. `max_terms` is
    /// applied per fresh snapshot (the cached entry is returned
    /// verbatim — assume the same `max_terms` across calls in
    /// practice).
    pub fn get_or_refresh(&self, ttl: Duration, max_terms: usize) -> Vec<String> {
        // Fast path: return the cached vocab if fresh.
        {
            let guard = self.inner.lock();
            if let Some(snap) = guard.as_ref() {
                if snap.taken_at.elapsed() < ttl {
                    return snap.vocab.clone();
                }
            }
        }

        // Slow path: run a fresh snapshot. We deliberately do NOT
        // hold the lock across the OCR call (could block for ~hundreds
        // of ms). Race condition: two callers might both run a
        // snapshot — the cost is one extra OCR pass, no correctness
        // bug.
        let vocab = snapshot_vocab(max_terms);
        let snap = CachedSnapshot {
            taken_at: Instant::now(),
            vocab: vocab.clone(),
        };
        *self.inner.lock() = Some(snap);
        vocab
    }

    /// Convenience: refresh-or-cache with [`DEFAULT_TTL`] and
    /// [`DEFAULT_MAX_TERMS`].
    pub fn get(&self) -> Vec<String> {
        self.get_or_refresh(DEFAULT_TTL, DEFAULT_MAX_TERMS)
    }

    /// Discard any cached snapshot. Call after the user toggles the
    /// feature off / changes settings, so a stale list doesn't leak
    /// into the next session if they re-enable.
    pub fn invalidate(&self) {
        *self.inner.lock() = None;
    }
}
