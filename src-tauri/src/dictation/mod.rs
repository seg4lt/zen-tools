//! Tauri layer for the local-dictation feature.
//!
//! Owns the [`zen_dictation::DictationManager`], surfaces it via the
//! commands in [`commands`], and renders an ephemeral mic-icon menu-bar
//! tray ([`tray`]) while a recording is in progress.
//!
//! Gated on the merged main branch's per-tool kill-switch
//! (`Preferences::disabled_tools`, key `"dictation"`). When the tool
//! is disabled:
//!
//! * No CGEventTap is installed → right-⌘ does nothing dictation-related.
//! * No mic tray icon ever appears.
//! * No Whisper model auto-downloads.
//! * The hotkey handle stored on the manager is dropped, which now
//!   properly tears down the run-loop source (see
//!   `zen_dictation::hotkey::macos::TapHandle`'s Drop impl).
//!
//! Toggling back on re-arms everything live without an app restart,
//! mirroring how `prmaster_lifecycle` handles PRMaster.

pub mod commands;
pub mod dto;
pub mod lifecycle;
pub mod state;
pub mod tray;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::preferences;
use crate::user_config::UserConfig;
use state::DictationTauriState;
use zen_dictation::{HotkeyEvent, ModelId};

/// Storage key for the persisted selected-model id (kebab-case wire
/// form, e.g. `"base"`, `"large-v3-turbo"`).
const SELECTED_MODEL_KEY: &str = "dictation.selected_model";

/// Tool id used in `Preferences::disabled_tools`. Must match the
/// string the front-end passes to `set_tool_disabled`.
pub const TOOL_ID: &str = "dictation";

/// Whether the dictation tool is currently enabled. Reads
/// `Preferences::disabled_tools` from the persisted user config and
/// returns `false` if `"dictation"` is present.
pub fn is_app_enabled(app: &AppHandle) -> bool {
    !preferences::load_preferences(app)
        .map(|p| p.disabled_tools.iter().any(|id| id == TOOL_ID))
        .unwrap_or(false)
}

/// Resolve `<app_data_dir>/models/`, creating the directory if it
/// doesn't already exist. Used by the Tauri bootstrap and by every
/// command that reads / writes a model file.
pub fn models_dir(app: &AppHandle) -> std::io::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
        .join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve `<app_data_dir>/logs/`, creating the directory if needed.
pub fn logs_dir(app: &AppHandle) -> std::io::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
        .join("logs");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Bootstrap the dictation subsystem from `setup()`. Hydrates the
/// persisted selected model and, if the tool is enabled, hands off to
/// [`lifecycle::start`] to install the hotkey watcher and download
/// the base model. Safe to call regardless of the disabled state —
/// the lifecycle module is a no-op when the tool is off.
pub fn bootstrap(app: &AppHandle) {
    // Hydrate the persisted selection (if any).
    if let Some(id_str) = app
        .try_state::<UserConfig>()
        .and_then(|cfg| cfg.get::<String>(SELECTED_MODEL_KEY).ok().flatten())
    {
        if let Ok(id) = ModelId::parse(&id_str) {
            if let Some(state) = app.try_state::<DictationTauriState>() {
                state.manager.set_selected_model(id);
            }
        }
    }

    if !is_app_enabled(app) {
        tracing::info!("dictation: disabled in preferences; skipping activation");
        return;
    }
    lifecycle::start(app);
}

/// Install the long-press watcher on the main thread (CGEventTap
/// requires this). Returns immediately on the calling thread; the
/// closure runs on the next run-loop tick.
pub(crate) fn install_hotkey(app: &AppHandle, state: &DictationTauriState) {
    let app_for_cb = app.clone();
    let state_for_cb = state.clone();
    let result = zen_dictation::hotkey::start_long_press_watcher(move |event| {
        on_hotkey(&app_for_cb, &state_for_cb, event);
    });
    match result {
        Ok(handle) => state.manager.set_hotkey_handle(Some(handle)),
        Err(e) => tracing::warn!(?e, "dictation: hotkey watcher install failed"),
    }
}

fn on_hotkey(app: &AppHandle, state: &DictationTauriState, event: HotkeyEvent) {
    match event {
        HotkeyEvent::LongPressStart => {
            if let Err(e) = state.manager.start_recording() {
                tracing::warn!(?e, "dictation: start_recording failed");
                // Make sure we don't leave the tray showing a stale
                // state if mic open failed.
                tray::set_state(app, tray::MicTrayState::Hidden);
                let _ = app.emit("dictation:status", "idle");
                return;
            }
            tray::set_state(app, tray::MicTrayState::Recording);
            let _ = app.emit("dictation:status", "recording");
        }
        HotkeyEvent::Released => {
            // Don't tear the tray down yet — flip the tooltip to
            // "Transcribing…" so the user has feedback that work is
            // still happening after they let go of ⌘. The tray is
            // hidden once `finalise_recording` resolves (success,
            // empty, or error) below.
            tray::set_state(app, tray::MicTrayState::Transcribing);
            let _ = app.emit("dictation:status", "transcribing");

            // Run inference on a worker so the run loop is freed.
            let app = app.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let models_dir = state.models_dir.clone();
                let outcome = tokio::task::spawn_blocking(move || {
                    state.manager.finalise_recording(&models_dir)
                })
                .await;
                match outcome {
                    Ok(Ok(text)) if !text.is_empty() => {
                        tracing::info!(chars = text.chars().count(), "dictation: pasting transcript");
                        if let Err(e) = zen_dictation::paste::paste_text(&text) {
                            tracing::warn!(?e, "dictation: paste failed");
                        }
                    }
                    Ok(Ok(_)) => {
                        tracing::info!("dictation: empty transcript, nothing pasted");
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(?e, "dictation: transcription failed");
                    }
                    Err(e) => {
                        tracing::warn!(?e, "dictation: spawn_blocking join failed");
                    }
                }
                // Always clear the tray and signal idle, even on the
                // empty / error paths — otherwise a botched
                // transcription would leave a "Transcribing…" mic
                // sitting in the menu bar forever.
                tray::set_state(&app, tray::MicTrayState::Hidden);
                let _ = app.emit("dictation:status", "idle");
            });
        }
    }
}

/// Make sure the model file is on disk. If it isn't, download it,
/// emitting `dictation:download-progress` events to the frontend so
/// the settings UI can render its progress bar.
pub async fn ensure_model_present(
    app: &AppHandle,
    state: &DictationTauriState,
    id: ModelId,
) -> Result<(), zen_dictation::DictationError> {
    let path = id.path_in(&state.models_dir);
    if path.exists() {
        return Ok(());
    }
    let app = app.clone();
    let id_for_progress = id;
    zen_dictation::download::download_model(id, &state.models_dir, move |p| {
        let _ = app.emit(
            "dictation:download-progress",
            dto::DownloadProgressDto {
                model_id: id_for_progress.as_wire().to_string(),
                downloaded: p.downloaded,
                total: p.total,
            },
        );
    })
    .await?;
    Ok(())
}
