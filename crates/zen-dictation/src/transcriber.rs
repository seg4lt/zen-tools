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

    /// Transcribe with an optional list of contextual vocabulary
    /// strings to bias the recogniser. Empty `vocab` is equivalent to
    /// [`Self::transcribe`].
    ///
    /// The default implementation forwards to `transcribe` and
    /// ignores the vocab — so impls that don't (or can't) consume
    /// hints don't have to override anything. Apple Speech and
    /// Whisper both override to plumb the vocab into their
    /// respective contextualisation knobs (`contextualStrings` /
    /// `initial_prompt`).
    fn transcribe_with_vocab(
        &mut self,
        samples: &[f32],
        _vocab: &[String],
    ) -> Result<String, DictationError> {
        self.transcribe(samples)
    }
}

/// Blanket impl so `Box<dyn Transcriber>` itself satisfies `Transcriber`.
/// Lets the manager hold either a concrete provider or a boxed dyn
/// without juggling extra `match` arms at every call site.
impl Transcriber for Box<dyn Transcriber> {
    fn transcribe(&mut self, samples: &[f32]) -> Result<String, DictationError> {
        (**self).transcribe(samples)
    }

    fn transcribe_with_vocab(
        &mut self,
        samples: &[f32],
        vocab: &[String],
    ) -> Result<String, DictationError> {
        (**self).transcribe_with_vocab(samples, vocab)
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

    fn transcribe_with_vocab(
        &mut self,
        samples: &[f32],
        vocab: &[String],
    ) -> Result<String, DictationError> {
        // whisper.cpp's `initial_prompt` is a single sentence
        // fragment, capped at ~224 tokens internally. Format the
        // vocab as a comma-separated list with a brief prefix so the
        // decoder treats it as conversational context (a "topic of
        // conversation" hint) rather than text it must reproduce.
        let prompt = if vocab.is_empty() {
            String::new()
        } else {
            // Truncate at ~30 terms — keeps us comfortably under the
            // 224-token cap even with multi-syllable terms, and
            // longer prompts measurably hurt latency.
            let limit = vocab.len().min(30);
            let mut s = String::from("Context: ");
            s.push_str(&vocab[..limit].join(", "));
            s.push('.');
            s
        };
        zen_whisper::WhisperContext::transcribe_with_prompt(self, samples, &prompt)
            .map_err(DictationError::from)
    }
}

