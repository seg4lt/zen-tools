//! Owner of the live dictation pipeline state — selected model, loaded
//! whisper context, current mic capture, hotkey handle.
//!
//! The Tauri layer constructs one of these in `setup()` and drives it
//! through commands. The manager itself doesn't know about Tauri; it
//! just holds primitives and exposes the ops the Tauri commands need.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::error::DictationError;
use crate::hotkey::HotkeyHandle;
use crate::mic::MicCapture;
use crate::models::{ModelId, ModelStatus};

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
/// * `context` — `whisper_context*`. `Drop` calls `whisper_free`. Released
///   when the context is replaced (model switch) or the manager itself
///   drops.
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
    selected_model: Option<ModelId>,
    /// Loaded whisper context. Lazily populated on first transcription
    /// after the selected model file is on disk. Reset to `None` on
    /// model switch so the next transcription reloads the new weights.
    context: Option<zen_whisper::WhisperContext>,
    /// Active microphone capture. `Some` between toggle-on and
    /// toggle-off (or until `abandon_recording` runs).
    mic: Option<MicCapture>,
    /// Hotkey watcher handle. Held to keep the CGEventTap installed.
    hotkey: Option<HotkeyHandle>,
    is_recording: bool,
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
        Ok(())
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
    }

    /// Stop recording, run whisper, and return the transcript.
    /// Pasting is left to the caller because that involves Tauri
    /// signals (clipboard plugin permissions etc.). The selected model
    /// must already be on disk — call this *after* the Tauri layer has
    /// ensured the download succeeded.
    pub fn finalise_recording(
        &self,
        models_dir: &Path,
    ) -> Result<String, DictationError> {
        let (mic, model_id) = {
            let mut s = self.inner.lock();
            s.is_recording = false;
            let mic = s.mic.take().ok_or_else(|| {
                DictationError::Audio("finalise_recording with no active capture".into())
            })?;
            let model_id = s.selected_model.unwrap_or(ModelId::Base);
            (mic, model_id)
        };

        let samples = mic.stop()?;
        if samples.is_empty() {
            return Err(DictationError::Audio("no samples captured".into()));
        }

        // Lazily load the whisper context. We hold the manager lock
        // across the (potentially slow) load — the only other thing
        // that contends on this lock is mic state, which is already
        // taken.
        let mut s = self.inner.lock();
        if s.context.is_none() {
            let model_path = model_id.path_in(models_dir);
            let ctx = zen_whisper::WhisperContext::load(&model_path)?;
            s.context = Some(ctx);
        }
        let ctx = s
            .context
            .as_mut()
            .expect("context just populated");

        let text = ctx.transcribe(&samples)?;
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
