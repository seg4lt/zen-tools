//! [`WhisperContext`] — safe wrapper around `whisper_context *`.
//!
//! Single-threaded by construction: whisper.cpp's `whisper_full` mutates
//! internal buffers on the context, and is not safe to call concurrently
//! from multiple threads. Callers that need to share a context across
//! tasks should wrap it in a `Mutex` themselves.

use std::path::Path;

use crate::error::WhisperError;

/// Loaded whisper model + inference state.
///
/// Use [`WhisperContext::load`] to construct from a `.bin` ggml model
/// file (download via `zen-dictation`'s download module). Call
/// [`WhisperContext::transcribe`] with **16 kHz f32 mono** PCM samples;
/// `zen-dictation::mic` produces this format.
pub struct WhisperContext {
    #[cfg(target_os = "macos")]
    ctx: *mut crate::sys::whisper_context,
    #[cfg(not(target_os = "macos"))]
    _phantom: (),
}

// SAFETY: A `*mut whisper_context` is just a heap allocation; it does
// not contain thread-local state. The actual concurrency contract is
// "one thread at a time" — enforced by `&mut self` on the inference
// methods.
#[cfg(target_os = "macos")]
unsafe impl Send for WhisperContext {}

#[cfg(target_os = "macos")]
impl WhisperContext {
    /// Load a ggml model from disk. The file is expected to be one of
    /// the `ggml-*.bin` blobs from
    /// `huggingface.co/ggerganov/whisper.cpp`.
    pub fn load(model_path: &Path) -> Result<Self, WhisperError> {
        use std::ffi::CString;

        if !model_path.exists() {
            return Err(WhisperError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("model not found: {}", model_path.display()),
            )));
        }
        let c_path = CString::new(model_path.to_string_lossy().as_bytes()).map_err(|e| {
            WhisperError::ModelLoad(format!("model path is not a valid C string: {e}"))
        })?;

        // Use the default context params (Metal enabled at compile time
        // via `GGML_USE_METAL`). We don't currently surface
        // `whisper_context_params` to the caller — fine for v1.
        let params = unsafe { crate::sys::whisper_context_default_params() };
        let ctx = unsafe { crate::sys::whisper_init_from_file_with_params(c_path.as_ptr(), params) };
        if ctx.is_null() {
            return Err(WhisperError::ModelLoad(format!(
                "whisper_init_from_file_with_params returned NULL for {}",
                model_path.display()
            )));
        }
        Ok(Self { ctx })
    }

    /// Transcribe a buffer of 16 kHz f32 mono PCM samples. Returns the
    /// concatenated segment text with leading/trailing whitespace
    /// trimmed.
    ///
    /// The model is invoked with greedy sampling and English as the
    /// language. We deliberately keep the public surface small for v1;
    /// language / sampling configurability can be added later as
    /// optional builder-style methods.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, WhisperError> {
        self.transcribe_with_prompt(samples, "")
    }

    /// Transcribe with an optional `initial_prompt` string. whisper.cpp
    /// uses the prompt as decoder context — a sentence fragment
    /// containing words you'd like the recogniser to be more likely to
    /// surface. Capped at ~224 tokens internally; longer prompts are
    /// silently truncated by whisper.cpp.
    ///
    /// Pass an empty string for "no prompt" — equivalent to calling
    /// [`Self::transcribe`].
    pub fn transcribe_with_prompt(
        &mut self,
        samples: &[f32],
        initial_prompt: &str,
    ) -> Result<String, WhisperError> {
        use std::ffi::{CStr, CString};

        if samples.is_empty() {
            return Err(WhisperError::NoSpeech);
        }

        // Stash the prompt as a CString so the pointer we hand to
        // whisper.cpp lives across the inference call.
        let prompt_cstr: Option<CString> = if initial_prompt.is_empty() {
            None
        } else {
            CString::new(initial_prompt).ok()
        };

        // Greedy sampling is fast and adequate for short dictation
        // utterances; beam search (~2x slower) only marginally improves
        // accuracy on conversational speech.
        let mut params = unsafe {
            crate::sys::whisper_full_default_params(crate::sys::whisper_sampling_strategy_WHISPER_SAMPLING_GREEDY)
        };
        // Hard-coded English for v1. We can expose this via `set_language`
        // when the user picks a non-English transcription target.
        let lang = b"en\0";
        params.language = lang.as_ptr() as *const i8;
        params.translate = false;
        params.no_context = true;
        params.single_segment = false;
        params.print_progress = false;
        params.print_realtime = false;
        params.print_timestamps = false;
        params.print_special = false;
        // Suppress non-speech tokens (laughter etc.) so the pasted text
        // is just the words.
        params.suppress_blank = true;
        params.n_threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .min(8);
        if let Some(ref p) = prompt_cstr {
            params.initial_prompt = p.as_ptr();
        }

        let rc = unsafe {
            crate::sys::whisper_full(
                self.ctx,
                params,
                samples.as_ptr(),
                samples.len() as i32,
            )
        };
        // Keep `prompt_cstr` alive at least until whisper_full returns.
        drop(prompt_cstr);
        if rc != 0 {
            return Err(WhisperError::Inference(rc));
        }

        let n_segments = unsafe { crate::sys::whisper_full_n_segments(self.ctx) };
        if n_segments <= 0 {
            return Err(WhisperError::NoSpeech);
        }

        let mut out = String::new();
        for i in 0..n_segments {
            let raw = unsafe { crate::sys::whisper_full_get_segment_text(self.ctx, i) };
            if raw.is_null() {
                continue;
            }
            // SAFETY: whisper.cpp owns the returned pointer; it lives
            // until `whisper_free` is called, which only happens in our
            // `Drop` impl. We copy the bytes into an owned `String`
            // before returning.
            let s = unsafe { CStr::from_ptr(raw) }.to_string_lossy();
            out.push_str(s.as_ref());
        }

        Ok(out.trim().to_string())
    }
}

#[cfg(target_os = "macos")]
impl Drop for WhisperContext {
    fn drop(&mut self) {
        if !self.ctx.is_null() {
            unsafe { crate::sys::whisper_free(self.ctx) };
        }
    }
}

// ── Non-mac stub ────────────────────────────────────────────────────────
#[cfg(not(target_os = "macos"))]
impl WhisperContext {
    /// Stub — non-mac builds report `NotSupported`. We still expose the
    /// signature so callers don't need cfg-walls around their use sites.
    pub fn load(_model_path: &Path) -> Result<Self, WhisperError> {
        Err(WhisperError::NotSupported)
    }

    /// Stub — non-mac builds report `NotSupported`.
    pub fn transcribe(&mut self, _samples: &[f32]) -> Result<String, WhisperError> {
        Err(WhisperError::NotSupported)
    }

    /// Stub — non-mac builds report `NotSupported`.
    pub fn transcribe_with_prompt(
        &mut self,
        _samples: &[f32],
        _initial_prompt: &str,
    ) -> Result<String, WhisperError> {
        Err(WhisperError::NotSupported)
    }
}
