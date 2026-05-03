//! Tauri layer for the local-dictation feature.
//!
//! Owns the [`zen_dictation::DictationManager`], surfaces it via the
//! commands in [`commands`], and renders an ephemeral mic-icon menu-bar
//! tray ([`tray`]) while a recording is in progress.
//!
//! Gated on the global "app enabled" flag, which is being added in a
//! parallel branch by another agent. Until that lands the
//! [`is_app_enabled`] stub returns `false`, so the bootstrap in
//! `lib.rs` is a no-op and the React Settings page hides the
//! Dictation section. When the flag arrives, replace the body of
//! `is_app_enabled` with `cfg.get::<bool>("app.enabled")` (or whatever
//! key the flag agent settles on).

pub mod commands;
pub mod dto;
pub mod state;
pub mod tray;

use tauri::{AppHandle, Emitter, Manager};

use crate::user_config::UserConfig;
use state::DictationTauriState;
use zen_dictation::{HotkeyEvent, ModelId};

/// Storage key for the persisted selected-model id (kebab-case wire
/// form, e.g. `"base"`, `"large-v3-turbo"`).
const SELECTED_MODEL_KEY: &str = "dictation.selected_model";

/// Placeholder for the global app-enabled flag. The other agent will
/// replace this with a `UserConfig` read once the flag UI ships.
///
/// Temporarily defaulted to `true` so the hotkey watcher and base-model
/// download spin up at launch — that way the local-test loop matches
/// what users will eventually see when the real flag lands. Flip back
/// to `false` (or replace with the actual `cfg.get("app.enabled")`
/// read) once the parallel agent's branch merges.
pub fn is_app_enabled() -> bool {
    true
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

/// Bootstrap the dictation subsystem from `setup()`:
///
/// * Hydrates the persisted selected-model id (or defaults to Base).
/// * Spawns a background task that ensures the Base model is on disk
///   when the feature is enabled.
/// * Installs the long-press right-⌘ watcher on the main thread.
///
/// Safe to call regardless of [`is_app_enabled`] — it's a no-op when
/// the flag is off, so we wire it unconditionally and let the runtime
/// flag drive activation.
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

    if !is_app_enabled() {
        tracing::info!("dictation: app-enabled flag is off, skipping activation");
        return;
    }

    activate(app);
}

/// Wire up the hotkey watcher and kick off the Base-model download.
/// Idempotent — calling twice replaces the previous handle.
pub fn activate(app: &AppHandle) {
    let dictation_state = match app.try_state::<DictationTauriState>() {
        Some(s) => s.inner().clone(),
        None => {
            tracing::warn!("dictation: state not yet registered; skipping activate");
            return;
        }
    };

    // Ensure base model is on disk (download in background if needed).
    {
        let app_for_download = app.clone();
        let state_for_download = dictation_state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) =
                ensure_model_present(&app_for_download, &state_for_download, ModelId::Base).await
            {
                tracing::warn!(?e, "dictation: base model precheck failed");
            }
        });
    }

    // Install the long-press watcher on the main thread (CGEventTap
    // requires this). The Tauri `setup()` callback already runs on
    // main, but we use `run_on_main_thread` defensively in case
    // `activate()` is invoked from elsewhere later.
    let app_for_main = app.clone();
    let state_for_main = dictation_state;
    let _ = app.run_on_main_thread(move || {
        install_hotkey(&app_for_main, &state_for_main);
    });
}

fn install_hotkey(app: &AppHandle, state: &DictationTauriState) {
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
