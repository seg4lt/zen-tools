//! Provider-agnostic transcription abstraction.
//!
//! Two backends live behind this trait today:
//!
//! * `zen_whisper::WhisperContext` — vendored whisper.cpp + ggml, the
//!   original (and only) provider before we added Apple Speech support.
//!   Requires a `.bin` model file on disk under `<app_data>/models/`.
//!
//! * `zen_apple_speech::AppleSpeechContext` — Apple's on-device
//!   `SpeechAnalyzer` + `DictationTranscriber` introduced in macOS 26
//!   (Tahoe). Wraps a thin Swift bridge. No app-bundle download — the
//!   per-locale model lives in the system-wide `AssetInventory` store
//!   and is shared across every app on the machine.
//!
//! The trait is intentionally tiny: a single blocking `transcribe` call
//! over a `&[f32]` 16 kHz mono buffer. That mirrors what
//! [`crate::mic::MicCapture`] already produces (cpal capture + rubato
//! resample) and matches the existing press-to-talk UX where inference
//! runs once, after the user releases the hotkey, on a worker thread
//! via `tokio::task::spawn_blocking`. Streaming partial results would
//! require a richer trait; that's deferred until the UX needs it.

use crate::error::DictationError;

/// Provider-agnostic transcription backend.
///
/// Implementations must be `Send` because [`crate::DictationManager`]
/// runs `transcribe` from a `spawn_blocking` worker. `&mut self` makes
/// the contract explicit: a single transcription at a time per
/// instance — both whisper.cpp and Apple's `SpeechAnalyzer` mutate
/// internal state on each call, so neither can be safely used
/// concurrently from one handle.
pub trait Transcriber: Send {
    /// Transcribe a buffer of **16 kHz f32 mono** PCM samples. Returns
    /// the recognised text with leading/trailing whitespace trimmed.
    ///
    /// Implementations are expected to error with
    /// [`DictationError::Audio`] (or a provider-specific variant
    /// wrapped via `From`) when the buffer is empty or contains no
    /// recognisable speech.
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, DictationError>;
}

/// Blanket impl so `Box<dyn Transcriber>` itself satisfies `Transcriber`.
/// Lets the manager hold either a concrete provider or a boxed dyn
/// without juggling extra `match` arms at every call site.
impl Transcriber for Box<dyn Transcriber> {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, DictationError> {
        (**self).transcribe(samples)
    }
}

// ── Whisper provider impl ───────────────────────────────────────────────
//
// Defined here (rather than in `zen-whisper`) so `zen-whisper` stays a
// dumb FFI wrapper crate with no knowledge of dictation-specific error
// types. The signature on `WhisperContext::transcribe` already matches
// — this is a one-line forward.
impl Transcriber for zen_whisper::WhisperContext {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, DictationError> {
        zen_whisper::WhisperContext::transcribe(self, samples).map_err(DictationError::from)
    }
}

// ── Apple Speech provider impl ──────────────────────────────────────────
//
// Identical pattern to whisper. The `From<AppleSpeechError>` impl on
// `DictationError` (see `error.rs`) does the lifting.
impl Transcriber for zen_apple_speech::AppleSpeechContext {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, DictationError> {
        zen_apple_speech::AppleSpeechContext::transcribe(self, samples)
            .map_err(DictationError::from)
    }
}
