//! Safe Rust wrapper around the Apple Speech (`SpeechAnalyzer` /
//! `SpeechTranscriber`) Swift bridge that ships in
//! `swift/AppleSpeechBridge.swift`.
//!
//! Three layers:
//!
//! 1. `mod ffi` — `extern "C"` declarations matching the `@_cdecl`
//!    exports from the Swift side. Only present when the build script
//!    successfully compiled the bridge (cfg `apple_speech_compiled`).
//! 2. [`AppleSpeechContext`] — RAII wrapper that owns a transcriber
//!    handle and exposes a synchronous `transcribe` method matching
//!    the same shape `zen_whisper::WhisperContext::transcribe` uses.
//! 3. Top-level helpers ([`is_supported`], [`is_locale_installed`],
//!    [`install_locale`]) for the Tauri layer to query availability
//!    and trigger an explicit asset install.
//!
//! When the build can't produce the Swift dylib (non-macOS, or macOS
//! SDK older than 26), every entry point returns
//! [`AppleSpeechError::Unavailable`] and the caller falls back to
//! Whisper.

#![warn(missing_docs)]

#[cfg(all(target_os = "macos", apple_speech_compiled))]
use std::ffi::{CStr, CString};
#[cfg(all(target_os = "macos", apple_speech_compiled))]
use std::os::raw::c_char;

use thiserror::Error;

/// Default locale used when the caller doesn't pick one. Matches the
/// hard-coded `"en"` Whisper baseline so behaviour is consistent
/// across providers.
pub const DEFAULT_LOCALE: &str = "en-US";

/// Errors raised by the Apple Speech bridge.
#[derive(Debug, Error)]
pub enum AppleSpeechError {
    /// The Swift bridge isn't compiled into this build. Either the
    /// host isn't macOS, the macOS SDK was older than 26.0, or
    /// `ZEN_APPLE_SPEECH_FORCE_STUB=1` was set at build time.
    #[error("apple speech is not available in this build")]
    Unavailable,
    /// The bridge is compiled but the running OS is older than
    /// macOS 26 — `SpeechAnalyzer` isn't there at runtime.
    #[error("apple speech requires macOS 26 or later")]
    UnsupportedOs,
    /// A required locale isn't installed in `AssetInventory` yet.
    #[error("apple speech locale not installed: {0}")]
    LocaleMissing(String),
    /// Anything else the Swift bridge surfaced as an error string.
    #[error("apple speech: {0}")]
    Other(String),
}

// ── Real impl (Swift bridge compiled) ───────────────────────────────────

#[cfg(all(target_os = "macos", apple_speech_compiled))]
mod ffi {
    use std::os::raw::c_char;

    extern "C" {
        pub fn apple_speech_is_supported() -> i32;
        pub fn apple_speech_locale_installed(
            locale: *const c_char,
            out_error: *mut *mut c_char,
        ) -> i32;
        pub fn apple_speech_install_locale(
            locale: *const c_char,
            out_error: *mut *mut c_char,
        ) -> i32;
        pub fn apple_speech_create(locale: *const c_char) -> *mut std::ffi::c_void;
        pub fn apple_speech_destroy(handle: *mut std::ffi::c_void);
        pub fn apple_speech_transcribe(
            handle: *mut std::ffi::c_void,
            samples: *const f32,
            n_samples: usize,
            vocab: *const *const c_char,
            n_vocab: usize,
            out_text: *mut *mut c_char,
        ) -> i32;
        pub fn apple_speech_string_free(p: *mut c_char);
    }
}

/// Take ownership of a `*mut c_char` produced by the Swift bridge,
/// turn it into an owned Rust `String`, and free the original
/// allocation.
#[cfg(all(target_os = "macos", apple_speech_compiled))]
fn take_string(p: *mut c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: pointer was returned by `cstrdup` on the Swift side
    // (i.e. `strdup`), so it's a valid C string with NUL terminator.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { ffi::apple_speech_string_free(p) };
    s
}

/// `true` when the Swift bridge is in the binary AND the running OS
/// supports the underlying APIs (macOS 26+).
pub fn is_supported() -> bool {
    #[cfg(all(target_os = "macos", apple_speech_compiled))]
    {
        // SAFETY: the C entry point takes no arguments and is safe to
        // call from any thread.
        unsafe { ffi::apple_speech_is_supported() != 0 }
    }
    #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
    {
        false
    }
}

/// Check whether the on-device speech model for `locale` (e.g.
/// `"en-US"`) is installed in `AssetInventory`.
pub fn is_locale_installed(locale: &str) -> Result<bool, AppleSpeechError> {
    #[cfg(all(target_os = "macos", apple_speech_compiled))]
    {
        let c = CString::new(locale).map_err(|e| AppleSpeechError::Other(e.to_string()))?;
        let mut err_ptr: *mut c_char = std::ptr::null_mut();
        // SAFETY: `c.as_ptr()` lives until `c` is dropped at end of
        // function; the bridge copies the string before returning.
        let rc = unsafe { ffi::apple_speech_locale_installed(c.as_ptr(), &mut err_ptr) };
        if rc < 0 {
            return Err(AppleSpeechError::Other(take_string(err_ptr)));
        }
        Ok(rc == 1)
    }
    #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
    {
        let _ = locale;
        Err(AppleSpeechError::Unavailable)
    }
}

/// Synchronously download + install the on-device speech model for
/// `locale`, then reserve it. Blocks until the download completes —
/// the caller should run this from a worker thread.
pub fn install_locale(locale: &str) -> Result<(), AppleSpeechError> {
    #[cfg(all(target_os = "macos", apple_speech_compiled))]
    {
        let c = CString::new(locale).map_err(|e| AppleSpeechError::Other(e.to_string()))?;
        let mut err_ptr: *mut c_char = std::ptr::null_mut();
        let rc = unsafe { ffi::apple_speech_install_locale(c.as_ptr(), &mut err_ptr) };
        if rc < 0 {
            return Err(AppleSpeechError::Other(take_string(err_ptr)));
        }
        Ok(())
    }
    #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
    {
        let _ = locale;
        Err(AppleSpeechError::Unavailable)
    }
}

/// RAII handle to a Swift-side transcriber.
pub struct AppleSpeechContext {
    #[cfg(all(target_os = "macos", apple_speech_compiled))]
    handle: *mut std::ffi::c_void,
    #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
    _phantom: (),
    locale: String,
}

// SAFETY: the Swift bridge pins each call onto a Task and blocks the
// calling thread on a semaphore, so the underlying analyzer is only
// touched from the dispatched async context. The handle itself is
// just a retained Swift class pointer and is safe to move between
// threads.
unsafe impl Send for AppleSpeechContext {}

impl AppleSpeechContext {
    /// Build a transcriber bound to `locale`. The locale must already
    /// be installed in `AssetInventory` — call [`install_locale`]
    /// first if [`is_locale_installed`] returns `false`.
    pub fn new(locale: &str) -> Result<Self, AppleSpeechError> {
        if !is_supported() {
            return Err(if cfg!(target_os = "macos") {
                AppleSpeechError::UnsupportedOs
            } else {
                AppleSpeechError::Unavailable
            });
        }
        if !is_locale_installed(locale)? {
            return Err(AppleSpeechError::LocaleMissing(locale.to_string()));
        }

        #[cfg(all(target_os = "macos", apple_speech_compiled))]
        {
            let c = CString::new(locale).map_err(|e| AppleSpeechError::Other(e.to_string()))?;
            let handle = unsafe { ffi::apple_speech_create(c.as_ptr()) };
            if handle.is_null() {
                return Err(AppleSpeechError::Other(
                    "apple_speech_create returned null".into(),
                ));
            }
            Ok(Self {
                handle,
                locale: locale.to_string(),
            })
        }
        #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
        {
            Err(AppleSpeechError::Unavailable)
        }
    }

    /// Locale this transcriber was bound to (for diagnostics).
    pub fn locale(&self) -> &str {
        &self.locale
    }

    /// Transcribe a 16 kHz f32 mono PCM buffer. Returns the
    /// recognised text, trimmed of leading/trailing whitespace.
    ///
    /// Convenience wrapper around [`Self::transcribe_with_vocab`]
    /// that passes an empty vocabulary list — preserves the v1 call
    /// site shape while letting newer code opt into contextual hints.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, AppleSpeechError> {
        self.transcribe_with_vocab(samples, &[])
    }

    /// Transcribe with an optional list of contextual vocabulary
    /// strings. Each entry biases the recogniser toward terms it
    /// might otherwise miss (proper nouns, code identifiers OCR'd
    /// off the user's screen).
    ///
    /// Pass an empty slice for "no vocabulary hint" — equivalent to
    /// calling [`Self::transcribe`].
    pub fn transcribe_with_vocab(
        &mut self,
        samples: &[f32],
        vocab: &[String],
    ) -> Result<String, AppleSpeechError> {
        if samples.is_empty() {
            return Err(AppleSpeechError::Other("no samples".into()));
        }

        #[cfg(all(target_os = "macos", apple_speech_compiled))]
        {
            // Stage the vocab as `Vec<CString>` so the C strings stay
            // alive across the call, plus a parallel `Vec<*const
            // c_char>` of pointers we hand to Swift.
            let cstrings: Vec<CString> = vocab
                .iter()
                .filter_map(|s| CString::new(s.as_str()).ok())
                .collect();
            let ptrs: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();

            let mut out_ptr: *mut c_char = std::ptr::null_mut();
            // SAFETY: `samples.as_ptr()` and `samples.len()` describe
            // the buffer the Swift side memcpys before returning. The
            // handle was created in `new()` and is non-null. `ptrs`
            // (and the `cstrings` it borrows from) outlive the call
            // — we don't drop either until after Swift returns.
            let rc = unsafe {
                ffi::apple_speech_transcribe(
                    self.handle,
                    samples.as_ptr(),
                    samples.len(),
                    if ptrs.is_empty() {
                        std::ptr::null()
                    } else {
                        ptrs.as_ptr()
                    },
                    ptrs.len(),
                    &mut out_ptr,
                )
            };
            let text = take_string(out_ptr);
            // Drop in explicit order so `cstrings` outlives `ptrs`,
            // both outlive the FFI call. The compiler would do this
            // anyway via reverse-declaration drop order — explicit
            // drops just defend against future code shuffling.
            drop(ptrs);
            drop(cstrings);
            if rc < 0 {
                if text.contains("not installed") {
                    return Err(AppleSpeechError::LocaleMissing(self.locale.clone()));
                }
                return Err(AppleSpeechError::Other(text));
            }
            Ok(text)
        }
        #[cfg(not(all(target_os = "macos", apple_speech_compiled)))]
        {
            let _ = (samples, vocab);
            Err(AppleSpeechError::Unavailable)
        }
    }
}

impl Drop for AppleSpeechContext {
    fn drop(&mut self) {
        #[cfg(all(target_os = "macos", apple_speech_compiled))]
        unsafe {
            if !self.handle.is_null() {
                ffi::apple_speech_destroy(self.handle);
                self.handle = std::ptr::null_mut();
            }
        }
    }
}
