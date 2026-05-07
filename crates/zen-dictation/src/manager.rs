//! Owner of the live dictation pipeline state — selected model, loaded
//! whisper context, current mic capture, hotkey handle.
//!
//! The Tauri layer constructs one of these in `setup()` and drives it
//! through commands. The manager itself doesn't know about Tauri; it
//! just holds primitives and exposes the ops the Tauri commands need.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;

use parking_lot::Mutex;

use crate::error::DictationError;
use crate::hotkey::HotkeyHandle;
use crate::mic::MicCapture;
use crate::models::{ModelId, ModelStatus};
use crate::provider::Provider;
use crate::transcriber::Transcriber;

/// Maximum wall time we'll wait at the end of a recording for the
/// background screen-vocab OCR pass to complete. If it doesn't
/// return within this budget we transcribe without a vocabulary
/// hint — better to ship a slightly less accurate transcript than
/// add visible latency on top of the user's hotkey release.
///
/// Initially set to 250 ms but ScreenCaptureKit's first call after
/// permission is granted (or after a long idle) routinely takes
/// ≥1 s while it spins up the capture daemon, and even subsequent
/// calls on a multi-monitor rig at 4K push past 500 ms. 1.5 s gives
/// us comfortable headroom; if the OCR pass still hasn't returned
/// by then it's almost certainly a TCC-permission failure rather
/// than slow OCR, and falling back to "no vocab" is the right call.
const SCREEN_VOCAB_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// Hotkey events emitted by the platform watcher.
///
/// Single variant: the watcher fires `Toggle` whenever the user
/// completes the **tap-then-long-press** gesture on right ⌘. The
/// Tauri-layer consumer reads `DictationManager::is_recording()` to
/// decide whether this should start or stop the pipeline.
#[derive(Debug, Clone, Copy)]
pub enum HotkeyEvent {
    /// User completed the tap-then-long-press gesture. If we're not
    /// already recording, start; if we are, stop and transcribe.
    Toggle,
}

/// Owner of all dictation state. Cheap to clone (one `Arc` deep).
#[derive(Clone, Default)]
pub struct DictationManager {
    inner: Arc<Mutex<Inner>>,
}

/// Teardown summary (for the listener-leak audit):
///
/// * `context` — `Box<dyn Transcriber>` wrapping either a
///   `whisper_context*` (Drop calls `whisper_free`) or an
///   `AppleSpeechContext` (Drop calls `apple_speech_destroy` on the
///   Swift handle). Released when the provider/model is switched or
///   the manager itself drops.
/// * `mic` — `cpal::Stream`. `Drop` tears down the audio thread. Released
///   in `finalise_recording` (transcribe path) and `abandon_recording`
///   (toggle-off-while-disabled path).
/// * `hotkey` — `HotkeyHandle` (CGEventTap + CFRunLoopSource + run-loop
///   ref). `Drop` calls `CGEventTapEnable(false)`,
///   `CFRunLoopRemoveSource`, then releases the wrapper retains so the
///   tap is fully detached from the run loop. Released in
///   `set_hotkey_handle(None)` (lifecycle stop / restart) and on
///   manager drop.
///
/// Pending long-press timer threads in `crates/zen-dictation/src/hotkey/macos.rs`
/// hold weak-by-construction references (Arc clones to `TapState` and the
/// callback). When the watcher is dropped they continue to sleep until
/// the 500 ms window elapses, observe a generation mismatch, and exit
/// without firing. Bounded ≤500 ms; not a leak.
#[derive(Default)]
struct Inner {
    /// Top-level transcription backend (Apple Speech vs Whisper).
    /// Defaults to whatever [`Provider::default`] returns; the Tauri
    /// layer overrides this from the persisted user config at startup.
    provider: Provider,
    /// Whisper-only model selection. Read only when
    /// `provider == Provider::Whisper`.
    selected_model: Option<ModelId>,
    /// Loaded transcription backend. Lazily populated on first
    /// transcription after the selected model is ready (Whisper:
    /// model file on disk; Apple Speech: locale installed in
    /// `AssetInventory`). Reset to `None` on provider/model switch so
    /// the next transcription rebuilds the right backend.
    context: Option<Box<dyn Transcriber>>,
    /// Active microphone capture. `Some` between toggle-on and
    /// toggle-off (or until `abandon_recording` runs).
    mic: Option<MicCapture>,
    /// Hotkey watcher handle. Held to keep the CGEventTap installed.
    hotkey: Option<HotkeyHandle>,
    is_recording: bool,
    /// User-facing toggle for the screen-vocabulary feature. When
    /// `true`, [`Self::start_recording`] kicks off a background OCR
    /// pass over the current screen and [`Self::finalise_recording`]
    /// awaits it (with a small timeout) so the recogniser sees the
    /// vocabulary hint. Defaults to `false` for privacy — the user
    /// has to opt in via Settings, and the first toggle triggers the
    /// macOS Screen Recording TCC prompt.
    screen_vocab_enabled: bool,
    /// Receiver for the in-flight screen-vocab OCR pass started in
    /// [`Self::start_recording`]. `Some` only between start and
    /// finalise (or abandon, which clears it). The sender side runs
    /// on a detached thread; if the receive end is dropped before
    /// the thread finishes, the `send` errors silently and the
    /// thread exits.
    pending_vocab: Option<mpsc::Receiver<Vec<String>>>,
}

impl DictationManager {
    /// Create an empty manager with no model selected.
    pub fn new() -> Self {
        Self::default()
    }

    /// Currently-selected model id (or `None` if the user hasn't
    /// chosen one yet — typically resolved by the Tauri layer falling
    /// back to [`ModelId::Base`] on first run).
    pub fn selected_model(&self) -> Option<ModelId> {
        self.inner.lock().selected_model
    }

    /// Set the selected model. Drops the cached `WhisperContext` so the
    /// next transcription loads from disk against the new model file.
    pub fn set_selected_model(&self, id: ModelId) {
        let mut s = self.inner.lock();
        if s.selected_model != Some(id) {
            s.context = None;
        }
        s.selected_model = Some(id);
    }

    /// Currently-selected transcription provider.
    pub fn provider(&self) -> Provider {
        self.inner.lock().provider
    }

    /// Switch the active transcription provider. Drops any cached
    /// backend so the next transcription rebuilds against the new
    /// provider — required because the trait object isn't safe to
    /// reuse across providers (the inner `WhisperContext` /
    /// `AppleSpeechContext` types are different).
    pub fn set_provider(&self, p: Provider) {
        let mut s = self.inner.lock();
        if s.provider != p {
            s.context = None;
        }
        s.provider = p;
    }

    /// `true` while the manager has an active microphone capture.
    pub fn is_recording(&self) -> bool {
        self.inner.lock().is_recording
    }

    /// Walk the model registry and pair each entry with whether its
    /// `.bin` file exists in `models_dir`.
    pub fn list_model_status(&self, models_dir: &Path) -> Vec<ModelStatus> {
        ModelId::all_fast_to_slow()
            .iter()
            .copied()
            .map(|id| ModelStatus {
                id,
                downloaded: id.path_in(models_dir).exists(),
            })
            .collect()
    }

    /// Begin recording (called from the hotkey thread on
    /// `HotkeyEvent::LongPressStart`).
    pub fn start_recording(&self) -> Result<(), DictationError> {
        let mut s = self.inner.lock();
        if s.mic.is_some() {
            return Ok(());
        }
        let mic = MicCapture::start()?;
        s.mic = Some(mic);
        s.is_recording = true;

        // Kick off screen vocabulary OCR in parallel with the
        // recording. We use a one-shot mpsc channel because the
        // worker thread shouldn't outlive the dictation manager —
        // dropping the receiver in `abandon_recording` (or just
        // letting `finalise_recording` consume it) is enough to
        // signal the worker to bail on send. The OCR call itself
        // blocks for ~hundreds of ms, well within the typical
        // recording duration, so by the time the user releases the
        // hotkey the vocab is usually ready and the receive in
        // `finalise_recording` is non-blocking.
        if s.screen_vocab_enabled {
            let (tx, rx) = mpsc::channel::<Vec<String>>();
            s.pending_vocab = Some(rx);
            // Detach: the thread sends once and exits. We don't join
            // it — `mpsc::Sender::send` returns an `Err` if the
            // receiver was dropped, which is the only failure mode
            // we care about (manager went away mid-OCR).
            thread::spawn(move || {
                let vocab = zen_screen_vocab::snapshot_vocab(
                    zen_screen_vocab::DEFAULT_MAX_TERMS,
                );
                let _ = tx.send(vocab);
            });
        }

        Ok(())
    }

    /// Set whether the screen-vocabulary OCR pipeline runs alongside
    /// each recording. Persisted by the Tauri layer; this setter is
    /// the single in-memory source of truth the manager reads from
    /// inside [`Self::start_recording`] / [`Self::finalise_recording`].
    pub fn set_screen_vocab_enabled(&self, enabled: bool) {
        let mut s = self.inner.lock();
        s.screen_vocab_enabled = enabled;
        if !enabled {
            // Drop any in-flight receiver so the worker thread's
            // next `send` errors and the thread exits.
            s.pending_vocab = None;
        }
    }

    /// `true` when screen-vocab OCR runs alongside recordings. Mirror
    /// of the persisted setting; the Tauri layer reads this for the
    /// Settings DTO.
    pub fn screen_vocab_enabled(&self) -> bool {
        self.inner.lock().screen_vocab_enabled
    }

    /// Drop any in-flight microphone capture without transcribing.
    ///
    /// Called when the user toggles dictation off while a recording
    /// is in progress — we don't want a stale paste landing after
    /// the feature is disabled. Dropping the [`MicCapture`] tears
    /// down the cpal stream; whatever samples it already buffered
    /// are released with it.
    ///
    /// This does NOT cancel an inference that's already running on a
    /// worker thread — whisper.cpp's `whisper_full` doesn't expose a
    /// cancellation hook. The cost is bounded (a few seconds at
    /// most) and the worker exits silently with the abandoned
    /// transcript.
    pub fn abandon_recording(&self) {
        let mut s = self.inner.lock();
        s.is_recording = false;
        if let Some(mic) = s.mic.take() {
            // Explicit drop so the cpal stream is torn down before
            // we release the lock — avoids surprise audio thread
            // activity after we've signalled idle.
            drop(mic);
        }
        // Drop any pending vocab receiver too so the worker thread
        // (which may still be running OCR) sees its `send` error
        // and exits without us hearing about it.
        s.pending_vocab = None;
    }

    /// Stop recording, run the active transcription provider, and
    /// return the transcript. Pasting is left to the caller because
    /// that involves Tauri signals (clipboard plugin permissions
    /// etc.). For the Whisper provider, the selected model must
    /// already be on disk — call this *after* the Tauri layer has
    /// ensured the download succeeded. For Apple Speech, the locale
    /// must be installed in `AssetInventory`.
    pub fn finalise_recording(
        &self,
        models_dir: &Path,
    ) -> Result<String, DictationError> {
        let (mic, provider, model_id, pending_vocab) = {
            let mut s = self.inner.lock();
            s.is_recording = false;
            let mic = s.mic.take().ok_or_else(|| {
                DictationError::Audio("finalise_recording with no active capture".into())
            })?;
            let provider = s.provider;
            let model_id = s.selected_model.unwrap_or(ModelId::Base);
            let pending_vocab = s.pending_vocab.take();
            (mic, provider, model_id, pending_vocab)
        };

        let samples = mic.stop()?;
        if samples.is_empty() {
            return Err(DictationError::Audio("no samples captured".into()));
        }

        // Drain the screen-vocab worker, capping the wait at
        // [`SCREEN_VOCAB_TIMEOUT`]. By the time the user releases the
        // hotkey the recording has typically been running for at
        // least a second, which is far longer than a single OCR
        // pass — so this is almost always non-blocking. The cap
        // protects the dictation latency budget when the user
        // dictates immediately after the OCR pipeline kicked off
        // (e.g. tap-tap-hold within ~200ms).
        let vocab: Vec<String> = match pending_vocab {
            Some(rx) => match rx.recv_timeout(SCREEN_VOCAB_TIMEOUT) {
                Ok(v) => {
                    // Promoted to info so the user can see in logs
                    // whether vocab is actually flowing through (this
                    // is the first feature where the user has no
                    // visual feedback of what we picked up).
                    if v.is_empty() {
                        tracing::info!(
                            "dictation: screen vocab returned 0 terms (TCC permission \
                             missing? screen blank? extract heuristic too aggressive?)"
                        );
                    } else {
                        let preview: Vec<&str> = v
                            .iter()
                            .take(20)
                            .map(String::as_str)
                            .collect();
                        tracing::info!(
                            terms = v.len(),
                            preview = ?preview,
                            "dictation: screen vocab biasing transcription"
                        );
                    }
                    v
                }
                Err(e) => {
                    tracing::warn!(
                        ?e,
                        timeout_ms = SCREEN_VOCAB_TIMEOUT.as_millis() as u64,
                        "dictation: screen vocab timed out / errored; transcribing without hint"
                    );
                    Vec::new()
                }
            },
            None => Vec::new(),
        };

        // Lazily load the provider-specific backend. We hold the
        // manager lock across the (potentially slow) load — the only
        // other thing that contends on this lock is mic state, which
        // is already taken.
        let mut s = self.inner.lock();
        if s.context.is_none() {
            s.context = Some(build_context(provider, model_id, models_dir)?);
        }
        let ctx = s.context.as_mut().expect("context just populated");

        let text = if vocab.is_empty() {
            ctx.transcribe(&samples)?
        } else {
            ctx.transcribe_with_vocab(&samples, &vocab)?
        };
        Ok(text)
    }

    /// Resolve the on-disk path for the currently-selected model, or
    /// the default if none is selected.
    pub fn current_model_path(&self, models_dir: &Path) -> PathBuf {
        let id = self.selected_model().unwrap_or(ModelId::Base);
        id.path_in(models_dir)
    }

    /// Store a hotkey handle on the manager (extends its lifetime to
    /// match the manager's). Pass `None` to drop the existing handle
    /// and stop the tap.
    pub fn set_hotkey_handle(&self, handle: Option<HotkeyHandle>) {
        self.inner.lock().hotkey = handle;
    }
}

/// Build a transcription backend for the given provider. Pulled out
/// of `finalise_recording` so the dispatch is in one place and easy
/// to extend (a third provider — Linux Vosk, say — would slot in here
/// as another match arm).
fn build_context(
    provider: Provider,
    model_id: ModelId,
    models_dir: &Path,
) -> Result<Box<dyn Transcriber>, DictationError> {
    match provider {
        Provider::Whisper => {
            let path = model_id.path_in(models_dir);
            let ctx = zen_whisper::WhisperContext::load(&path)?;
            Ok(Box::new(ctx))
        }
    }
}
