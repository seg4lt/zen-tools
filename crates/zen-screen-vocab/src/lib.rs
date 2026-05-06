//! Capture the current screen via ScreenCaptureKit + Vision OCR, then
//! extract a contextual vocabulary list to bias dictation recognizers.
//!
//! Layout mirrors `zen-apple-speech`:
//!
//! 1. `mod ffi` — `extern "C"` declarations matching the `@_cdecl`
//!    exports in `swift/ScreenVocabBridge.swift`. Only present when
//!    `build.rs` actually compiled the bridge (cfg
//!    `screen_vocab_compiled`).
//! 2. [`snapshot_vocab`] — top-level entry. Captures, OCRs, filters,
//!    ranks, returns the top-N vocabulary terms. Stub on non-macOS /
//!    pre-Xcode-26 builds returns an empty `Vec<String>` so callers
//!    don't need cfg-walls.
//! 3. [`extract`] — pure-Rust tokenisation + UI-chrome filter + ranker.
//!    Lives in its own module so it's easy to unit-test against
//!    canned OCR strings.
//! 4. [`cache`] — small TTL'd cache around `snapshot_vocab` so rapid
//!    successive dictation triggers don't burn an OCR pass each time.
//!
//! Privacy: this crate reads pixels off the user's screen. The
//! caller (the dictation manager) is expected to gate calls behind a
//! user-facing toggle that defaults OFF, and to skip OCR entirely
//! when a sensitive app is frontmost. Nothing about a captured frame
//! is persisted to disk — the Vision `CGImage` and the resulting
//! `[String]` live exclusively in memory and are dropped at the end
//! of [`snapshot_vocab`].

#![warn(missing_docs)]

#[cfg(all(target_os = "macos", screen_vocab_compiled))]
use std::ffi::CStr;
#[cfg(all(target_os = "macos", screen_vocab_compiled))]
use std::os::raw::c_char;

use thiserror::Error;

pub mod cache;
pub mod extract;

pub use cache::{CachedSnapshot, VocabCache};

/// Default cap on how many vocabulary terms we return per snapshot.
/// Apple's `SpeechTranscriber` doesn't publish a hard limit on
/// `contextualStrings` but documented examples sit ≤ a few hundred —
/// 256 is a comfortable middle ground that doesn't bloat IPC or
/// transcriber init time.
pub const DEFAULT_MAX_TERMS: usize = 256;

/// Errors raised by the screen vocabulary bridge.
#[derive(Debug, Error)]
pub enum ScreenVocabError {
    /// The Swift bridge isn't compiled into this build (non-macOS, or
    /// SDK older than 26.0, or `ZEN_SCREEN_VOCAB_FORCE_STUB=1` was
    /// set at build time).
    #[error("screen vocab bridge is not available in this build")]
    Unavailable,
    /// Anything else the Swift bridge surfaced as an error string —
    /// usually "missing TCC permission" (the user hasn't granted
    /// Screen Recording yet) or a `ScreenCaptureKit` failure.
    #[error("screen vocab: {0}")]
    Other(String),
}

// ── Real impl (Swift bridge compiled) ───────────────────────────────────

#[cfg(all(target_os = "macos", screen_vocab_compiled))]
mod ffi {
    use std::os::raw::c_char;

    extern "C" {
        pub fn zen_screen_vocab_is_supported() -> i32;
        pub fn zen_screen_vocab_snapshot(out_text: *mut *mut c_char) -> i32;
        pub fn zen_screen_vocab_string_free(p: *mut c_char);
    }
}

#[cfg(all(target_os = "macos", screen_vocab_compiled))]
fn take_string(p: *mut c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { ffi::zen_screen_vocab_string_free(p) };
    s
}

/// `true` when the Swift bridge is in this binary AND the running OS
/// supports the underlying APIs.
pub fn is_supported() -> bool {
    #[cfg(all(target_os = "macos", screen_vocab_compiled))]
    {
        unsafe { ffi::zen_screen_vocab_is_supported() != 0 }
    }
    #[cfg(not(all(target_os = "macos", screen_vocab_compiled)))]
    {
        false
    }
}

/// Capture every connected display, OCR each, and return raw
/// recognised text lines (one per `VNRecognizedTextObservation`,
/// concatenated with newlines).
///
/// **Synchronous** — the Swift bridge wraps an async `Task` in a
/// `DispatchSemaphore` that parks the calling thread. Callers should
/// invoke this from a worker (`tokio::task::spawn_blocking` or a
/// dedicated thread); the dictation manager already does so.
///
/// Latency budget: ~50–150 ms per display in `.fast` mode, run in
/// parallel via a Swift `TaskGroup`. A 3-monitor rig is roughly
/// equivalent to a single OCR pass.
///
/// Returns `Err(ScreenVocabError::Unavailable)` on platforms / builds
/// where the bridge wasn't compiled. Callers that want to silently
/// fall through to "no vocab" should match on that variant and treat
/// it as `Vec::new()`.
pub fn raw_snapshot() -> Result<String, ScreenVocabError> {
    #[cfg(all(target_os = "macos", screen_vocab_compiled))]
    {
        let mut out_ptr: *mut c_char = std::ptr::null_mut();
        let rc = unsafe { ffi::zen_screen_vocab_snapshot(&mut out_ptr) };
        let text = take_string(out_ptr);
        if rc < 0 {
            return Err(ScreenVocabError::Other(text));
        }
        Ok(text)
    }
    #[cfg(not(all(target_os = "macos", screen_vocab_compiled)))]
    {
        Err(ScreenVocabError::Unavailable)
    }
}

/// Top-level: capture, OCR, tokenise, filter, rank — return the top-N
/// vocabulary terms suitable for an Apple Speech `contextualStrings`
/// list or a Whisper `initial_prompt` fragment.
///
/// `max_terms` caps the output. Pass [`DEFAULT_MAX_TERMS`] for the
/// recommended default.
///
/// On any error the call returns an empty `Vec<String>` after
/// logging a `tracing::debug` line — the dictation pipeline should
/// never fail just because OCR did.
pub fn snapshot_vocab(max_terms: usize) -> Vec<String> {
    match raw_snapshot() {
        Ok(text) => extract::extract_vocab(&text, max_terms),
        Err(ScreenVocabError::Unavailable) => {
            // Quiet on the unavailable path — that's the expected
            // case on every non-mac dev box, no need to log.
            Vec::new()
        }
        Err(e) => {
            tracing::debug!(?e, "screen vocab: snapshot failed; returning empty list");
            Vec::new()
        }
    }
}
