//! Mic-recording menu-bar indicator.
//!
//! Three-state tray that distinguishes **Recording** (mic is open and
//! capturing) from **Transcribing** (whisper.cpp is chewing on the
//! captured samples) — both surface as the same template mic icon but
//! with different tooltips, so the user gets feedback that something
//! is still happening after they release ⌘.
//!
//! The tray is created lazily and torn down only once the pipeline
//! has fully finished (whether the transcript pasted, was empty, or
//! errored). Mirrors the lazy create/drop pattern used by the
//! existing `tray::update_tray` (perf / process monitor) — including
//! the macOS-mandated "drop the `TrayIcon` on the main thread" dance.

use std::sync::{Mutex, OnceLock};

use tauri::{
    image::Image,
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle,
};

const TRAY_ID: &str = "zen-tools-dictation";

/// Embedded mic-icon PNG. Template variant so macOS auto-inverts for
/// light / dark menu bars. The asset lives in `src-tauri/icons/` and
/// is committed alongside the rest of the icon set.
const MIC_ICON_PNG: &[u8] = include_bytes!("../../icons/mic-tray-icon.png");

/// User-visible tray phases. The Tauri `dictation` module drives the
/// state machine; the tray is purely a render of whichever value is
/// passed to [`set_state`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicTrayState {
    /// No recording or transcription in flight — tray is removed.
    Hidden,
    /// Mic is open and accumulating samples (right ⌘ is held).
    Recording,
    /// Right ⌘ released; whisper is running and we're about to paste.
    Transcribing,
}

impl MicTrayState {
    fn tooltip(self) -> &'static str {
        match self {
            MicTrayState::Hidden => "",
            MicTrayState::Recording => "Dictation — recording. Release ⌘ to transcribe.",
            MicTrayState::Transcribing => "Dictation — transcribing…",
        }
    }
}

/// Cache the live tray handle so `set_state` can mutate or drop it on
/// the main thread. `OnceLock` lazily initialises the mutex on first
/// call.
static TRAY: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<TrayIcon>> {
    TRAY.get_or_init(|| Mutex::new(None))
}

/// Apply `state` to the tray.
///
/// * Hidden → drops the tray (on the main thread).
/// * Recording / Transcribing → builds the tray if missing, otherwise
///   just updates the tooltip in place.
///
/// Idempotent and safe to spam — the run-on-main-thread closure
/// serialises updates so two near-simultaneous calls can't race into
/// duplicate trays.
pub fn set_state(app: &AppHandle, state: MicTrayState) {
    let app_for_closure = app.clone();
    let result = app.run_on_main_thread(move || {
        let mut s = slot().lock().expect("dictation tray mutex poisoned");
        match state {
            MicTrayState::Hidden => {
                if let Some(t) = s.take() {
                    drop(t);
                    let _ = app_for_closure.remove_tray_by_id(TRAY_ID);
                    tracing::debug!("dictation: tray hidden");
                }
            }
            MicTrayState::Recording | MicTrayState::Transcribing => {
                let tooltip = state.tooltip();
                if let Some(t) = s.as_ref() {
                    if let Err(e) = t.set_tooltip(Some(tooltip)) {
                        tracing::warn!(?e, "dictation: tray set_tooltip failed");
                    }
                    tracing::debug!(?state, "dictation: tray tooltip updated");
                } else {
                    match build(&app_for_closure, tooltip) {
                        Ok(t) => {
                            *s = Some(t);
                            tracing::debug!(?state, "dictation: tray created");
                        }
                        Err(e) => tracing::warn!(?e, "dictation: tray build failed"),
                    }
                }
            }
        }
    });
    if let Err(e) = result {
        tracing::warn!(?e, ?state, "dictation: run_on_main_thread for tray failed");
    }
}

fn build(app: &AppHandle, tooltip: &str) -> tauri::Result<TrayIcon> {
    let icon = Image::from_bytes(MIC_ICON_PNG)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(tooltip)
        .show_menu_on_left_click(false)
        .build(app)
}
