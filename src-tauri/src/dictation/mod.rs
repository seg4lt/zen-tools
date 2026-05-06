//! Tauri layer for the local-dictation feature.
//!
//! Owns the [`zen_dictation::DictationManager`], surfaces it via the
//! commands in [`commands`], and renders a top-centre Dynamic Island-style
//! HUD ([`hud`]) while a recording is in progress.
//!
//! Gated on the merged main branch's per-tool kill-switch
//! (`Preferences::disabled_tools`, key `"dictation"`). When the tool
//! is disabled:
//!
//! * No CGEventTap is installed → right-⌘ does nothing dictation-related.
//! * No HUD overlay ever appears.
//! * No Whisper model auto-downloads.
//! * The hotkey handle stored on the manager is dropped, which now
//!   properly tears down the run-loop source (see
//!   `zen_dictation::hotkey::macos::TapHandle`'s Drop impl).
//!
//! Toggling back on re-arms everything live without an app restart,
//! mirroring how `prmaster_lifecycle` handles PRMaster.

pub mod commands;
pub mod dto;
pub mod install_id;
pub mod lifecycle;
pub mod permissions;
pub mod state;

// Note: dictation no longer owns its own menu-bar tray. The unified
// Zen Tools tray (`crate::tray`) renders a single "Disable dictation"
// menu item that hides automatically when the tool is disabled.

// Dynamic Island-style HUD overlay (top-centre pill) shown while
// dictation is recording or transcribing. macOS-only; on other
// platforms `hud::set_state` is a no-op stub so the call sites in
// `on_hotkey` don't need cfg-walls.
#[cfg(target_os = "macos")]
pub mod hud;
#[cfg(not(target_os = "macos"))]
pub mod hud {
    use tauri::AppHandle;
    #[derive(Debug, Clone, Copy)]
    pub enum HudState {
        Hidden,
        Recording,
        Transcribing,
    }
    pub fn set_state(_app: &AppHandle, _state: HudState) {}
}

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::preferences;
use crate::user_config::UserConfig;
use state::DictationTauriState;
use zen_dictation::{HotkeyEvent, ModelId, Provider};

/// Storage key for the persisted selected-model id (kebab-case wire
/// form, e.g. `"base"`, `"large-v3-turbo"`). Only consulted when the
/// active provider is Whisper.
pub(crate) const SELECTED_MODEL_KEY: &str = "dictation.selected_model";

/// Storage key for the persisted transcription provider id
/// (`"apple-speech"` | `"whisper"`).
pub(crate) const PROVIDER_KEY: &str = "dictation.provider";

/// Storage key for the persisted screen-vocabulary toggle
/// (`true` / `false`). Defaults to `false` for privacy — see
/// `dictation_set_screen_vocab` for the full UX rationale.
pub(crate) const SCREEN_VOCAB_KEY: &str = "dictation.screen_vocab_enabled";

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
/// persisted provider + selected model and, if the tool is enabled,
/// hands off to [`lifecycle::start`] to install the hotkey watcher
/// and download the base model. Safe to call regardless of the
/// disabled state — the lifecycle module is a no-op when the tool is
/// off.
///
/// **Provider default rule:**
/// * If `dictation.provider` is already persisted → use it verbatim.
/// * Else if `dictation.selected_model` is persisted (existing
///   install upgrading from a Whisper-only build) → default to
///   Whisper, preserving their previous choice without surprise
///   migration.
/// * Else (fresh install) on macOS 26+ with the Swift bridge → Apple
///   Speech.
/// * Else → Whisper.
pub fn bootstrap(app: &AppHandle) {
    let cfg = app.try_state::<UserConfig>();
    let state = app.try_state::<DictationTauriState>();

    // Hydrate the persisted Whisper-model selection (if any).
    let has_persisted_model =
        if let (Some(cfg), Some(state)) = (cfg.as_ref(), state.as_ref()) {
            let stored: Option<String> = cfg.get::<String>(SELECTED_MODEL_KEY).ok().flatten();
            if let Some(id_str) = stored.as_ref() {
                if let Ok(id) = ModelId::parse(id_str) {
                    state.manager.set_selected_model(id);
                }
            }
            stored.is_some()
        } else {
            false
        };

    // Resolve the provider per the rule documented above.
    if let (Some(cfg), Some(state)) = (cfg.as_ref(), state.as_ref()) {
        let stored_provider: Option<String> = cfg.get::<String>(PROVIDER_KEY).ok().flatten();
        let provider = if let Some(p) = stored_provider.as_ref().and_then(|s| Provider::parse(s).ok()) {
            p
        } else if has_persisted_model {
            // Existing install upgrading: don't migrate behind their
            // back. They can opt in via Settings.
            Provider::Whisper
        } else if zen_apple_speech::is_supported() {
            Provider::AppleSpeech
        } else {
            Provider::Whisper
        };
        state.manager.set_provider(provider);

        // Persist the resolved choice so the rule above only runs once.
        if stored_provider.is_none() {
            if let Err(e) = cfg.set(PROVIDER_KEY, &provider.as_wire().to_string()) {
                tracing::warn!(?e, "dictation: persist initial provider failed");
            }
        }

        // Hydrate the screen-vocab toggle. Default is OFF — the user
        // has to opt in; the first opt-in is what triggers the
        // Screen Recording TCC prompt.
        let stored_screen_vocab: Option<bool> =
            cfg.get::<bool>(SCREEN_VOCAB_KEY).ok().flatten();
        state
            .manager
            .set_screen_vocab_enabled(stored_screen_vocab.unwrap_or(false));
    }

    if !is_app_enabled(app) {
        tracing::info!("dictation: disabled in preferences; skipping activation");
        return;
    }
    lifecycle::start(app);
}

/// Install the tap-then-hold watcher on the main thread (CGEventTap
/// requires this). Returns immediately on the calling thread; the
/// closure runs on the next run-loop tick.
pub(crate) fn install_hotkey(app: &AppHandle, state: &DictationTauriState) {
    let app_for_cb = app.clone();
    let state_for_cb = state.clone();
    let result = zen_dictation::hotkey::start_double_tap_watcher(move |event| {
        on_hotkey(&app_for_cb, &state_for_cb, event);
    });
    match result {
        Ok(handle) => state.manager.set_hotkey_handle(Some(handle)),
        Err(e) => tracing::warn!(?e, "dictation: hotkey watcher install failed"),
    }
}

/// Dispatch a `HotkeyEvent::Toggle`. The single-event API means the
/// gesture itself doesn't carry direction — we read
/// `is_recording()` to decide between starting a fresh capture and
/// finalising the active one.
fn on_hotkey(app: &AppHandle, state: &DictationTauriState, _event: HotkeyEvent) {
    if state.manager.is_recording() {
        // ── Toggle OFF: stop capture, transcribe, paste ──────────
        // Don't tear the tray down yet — flip the tooltip to
        // "Transcribing…" so the user has feedback that work is
        // still happening after they let go of ⌘. The tray is
        // hidden once `finalise_recording` resolves (success,
        // empty, or error) below.
        hud::set_state(app, hud::HudState::Transcribing);
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
                Ok(Ok(text)) => {
                    // Two-step gate before we paste:
                    //   1. `is_likely_speech` — Whisper's non-speech
                    //      markers (`[Music]`, `[BLANK_AUDIO]`,
                    //      `(silence)`, `[Applause]`, …) come back
                    //      as the entire transcript when there's no
                    //      actual speech in the buffer. We must NOT
                    //      paste those into the user's editor.
                    //   2. We deliberately don't even touch the
                    //      pasteboard in the skip path. The previous
                    //      version called `paste_text(text)` which
                    //      would set `NSPasteboard.setString` first
                    //      and only then synthesise ⌘V — so a
                    //      non-speech transcript would still clobber
                    //      the user's clipboard with `[Music]`.
                    if zen_dictation::is_likely_speech(&text) {
                        tracing::info!(
                            chars = text.chars().count(),
                            "dictation: pasting transcript"
                        );
                        if let Err(e) = zen_dictation::paste::paste_text(&text) {
                            tracing::warn!(?e, "dictation: paste failed");
                        }
                    } else {
                        tracing::info!(
                            transcript = %text.trim(),
                            "dictation: transcript skipped (blank or non-speech); clipboard untouched"
                        );
                    }
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
            hud::set_state(&app, hud::HudState::Hidden);
            let _ = app.emit("dictation:status", "idle");
        });
    } else {
        // ── Toggle ON: start capture ─────────────────────────────
        if let Err(e) = state.manager.start_recording() {
            tracing::warn!(?e, "dictation: start_recording failed");
            // Make sure we don't leave the tray showing a stale
            // state if mic open failed.
            hud::set_state(app, hud::HudState::Hidden);
            let _ = app.emit("dictation:status", "idle");
            return;
        }
        hud::set_state(app, hud::HudState::Recording);
        let _ = app.emit("dictation:status", "recording");
    }
}

/// Make sure the Whisper model file is on disk. If it isn't,
/// download it, emitting `dictation:download-progress` events to the
/// frontend so the settings UI can render its progress bar.
///
/// Whisper-specific by design — Apple Speech doesn't have an
/// app-bundle download (its locale model lives in the system-wide
/// `AssetInventory` and is installed via the explicit
/// `dictation_install_apple_locale` command). Callers driven by the
/// lifecycle precheck call [`ensure_provider_ready`] instead so the
/// dispatch happens in one place.
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

/// Provider-aware readiness check. Whisper: ensure the selected
/// model file is on disk (kicks off a download if not). Apple
/// Speech: no-op — locale install is user-initiated via the explicit
/// "Install language model" button to honour the "never auto-install"
/// decision.
pub async fn ensure_provider_ready(
    app: &AppHandle,
    state: &DictationTauriState,
) -> Result<(), zen_dictation::DictationError> {
    match state.manager.provider() {
        Provider::Whisper => {
            let id = state.manager.selected_model().unwrap_or(ModelId::Base);
            ensure_model_present(app, state, id).await
        }
        Provider::AppleSpeech => Ok(()),
    }
}
