//! Tauri commands invoked by the frontend.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};
use zen_dictation::{ModelId, Provider};

use crate::dictation::dto::{
    DictationStateDto, ModelDto, PathsDto, ScreenVocabStateDto,
};
use crate::dictation::state::DictationTauriState;
use crate::dictation::{PROVIDER_KEY, SCREEN_VOCAB_KEY, SELECTED_MODEL_KEY};
use crate::error::{AppError, AppResult};
use crate::user_config::UserConfig;

fn build_model_dto(id: ModelId, models_dir: &Path) -> ModelDto {
    let path = id.path_in(models_dir);
    ModelDto {
        id: id.as_wire().to_string(),
        label: id.label().to_string(),
        size_label: id.size_label().to_string(),
        description: id.description().to_string(),
        is_default: id.is_default(),
        is_downloaded: path.exists(),
    }
}

/// Return every available model paired with download status. Sorted
/// fast-to-slow for the dropdown.
#[tauri::command]
pub async fn dictation_list_models(
    state: State<'_, DictationTauriState>,
) -> AppResult<Vec<ModelDto>> {
    Ok(ModelId::all_fast_to_slow()
        .iter()
        .copied()
        .map(|id| build_model_dto(id, &state.models_dir))
        .collect())
}

/// Snapshot used by the React settings page to populate the dropdown
/// + recording indicator on mount.
#[tauri::command]
pub async fn dictation_get_state(
    state: State<'_, DictationTauriState>,
) -> AppResult<DictationStateDto> {
    let models = ModelId::all_fast_to_slow()
        .iter()
        .copied()
        .map(|id| build_model_dto(id, &state.models_dir))
        .collect();
    let selected = state
        .manager
        .selected_model()
        .unwrap_or(ModelId::Base)
        .as_wire()
        .to_string();
    let provider = state.manager.provider();
    Ok(DictationStateDto {
        provider: provider.as_wire().to_string(),
        selected_model: selected,
        models,
        is_recording: state.manager.is_recording(),
        screen_vocab: ScreenVocabStateDto {
            supported: zen_screen_vocab::is_supported(),
            enabled: state.manager.screen_vocab_enabled(),
        },
    })
}

/// Persist a new model selection. Kicks an asynchronous download if
/// the chosen model isn't already on disk, so the next press of the
/// hotkey just works.
#[tauri::command]
pub async fn dictation_select_model(
    id: String,
    app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    let model = ModelId::parse(&id).map_err(|e| AppError::BadRequest(e.to_string()))?;
    state.manager.set_selected_model(model);

    // Persist into the shared user-config KV store.
    if let Some(cfg) = app.try_state::<UserConfig>() {
        if let Err(e) = cfg.set(SELECTED_MODEL_KEY, &model.as_wire().to_string()) {
            tracing::warn!(?e, "dictation: persist selected_model failed");
        }
    }

    if !model.path_in(&state.models_dir).exists() {
        let app2 = app.clone();
        let st2 = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::dictation::ensure_model_present(&app2, &st2, model).await {
                tracing::warn!(?e, "dictation: lazy download for selected model failed");
            }
        });
    }
    Ok(())
}

/// Force-download a specific model (used by the explicit
/// "Download now" button when a model isn't already on disk).
#[tauri::command]
pub async fn dictation_download_model(
    id: String,
    app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    let model = ModelId::parse(&id).map_err(|e| AppError::BadRequest(e.to_string()))?;
    {
        let mut in_flight = state.in_flight.lock();
        if !in_flight.insert(model.as_wire().to_string()) {
            // Already downloading — be idempotent.
            return Ok(());
        }
    }
    let app2 = app.clone();
    let st2 = state.inner().clone();
    let id_str = model.as_wire().to_string();
    tauri::async_runtime::spawn(async move {
        let result = crate::dictation::ensure_model_present(&app2, &st2, model).await;
        st2.in_flight.lock().remove(&id_str);
        if let Err(e) = result {
            tracing::warn!(?e, "dictation: download_model failed");
            let _ = app2.emit(
                "dictation:download-error",
                serde_json::json!({ "model_id": id_str, "message": e.to_string() }),
            );
        }
    });
    Ok(())
}

/// Switch the active transcription provider. Persists the choice into the KV store and drops any
/// cached backend so the next transcription rebuilds against the new
/// provider.
#[tauri::command]
pub async fn dictation_set_provider(
    provider: String,
    app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    let p = Provider::parse(&provider).map_err(|e| AppError::BadRequest(e.to_string()))?;
    state.manager.set_provider(p);
    if let Some(cfg) = app.try_state::<UserConfig>() {
        if let Err(e) = cfg.set(PROVIDER_KEY, &p.as_wire().to_string()) {
            tracing::warn!(?e, "dictation: persist provider failed");
        }
    }
    Ok(())
}

/// One-shot diagnostic: run the same OCR pipeline a real dictation
/// utterance would, return the resulting vocabulary list to the
/// frontend so the user can see exactly what the recogniser is being
/// biased toward (or, if the list is empty, get a clear "TCC denied
/// vs OCR found nothing" signal). Synchronous because the bridge
/// itself blocks; we run it on a `spawn_blocking` worker so the
/// Tauri runtime stays responsive.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ScreenVocabPreviewDto {
    /// `true` when the bridge is in the binary AND the OS supports
    /// the underlying APIs. `false` means the toggle would be hidden
    /// in Settings; calling this command returns an empty `terms`
    /// list and `error: "unavailable"`.
    pub supported: bool,
    /// Up to `DEFAULT_MAX_TERMS` extracted vocabulary terms. Empty
    /// list with `error: null` means OCR ran but found nothing
    /// useful (likely Screen Recording permission is granted but the
    /// screen contains no text our heuristic recognises). Empty list
    /// with `error != null` means OCR failed (most often because
    /// Screen Recording permission is denied).
    pub terms: Vec<String>,
    /// Optional error string surfaced from the Swift bridge —
    /// usually a TCC-permission-missing message.
    pub error: Option<String>,
}

/// Diagnostic command bound to the "Show what I see" button in
/// Settings. Captures + OCRs the current screen and returns the
/// extracted vocabulary so the user can self-diagnose whether
/// permission / heuristic / OCR is the failure point. Bypasses the
/// crate-level cache so each click is a fresh look.
#[tauri::command]
pub async fn dictation_test_screen_vocab() -> AppResult<ScreenVocabPreviewDto> {
    let supported = zen_screen_vocab::is_supported();
    if !supported {
        return Ok(ScreenVocabPreviewDto {
            supported: false,
            terms: Vec::new(),
            error: Some("unavailable".to_string()),
        });
    }

    // Run OCR + extraction on a worker. We deliberately bypass the
    // cache here — the user clicked Test, they expect a fresh look.
    let result = tokio::task::spawn_blocking(|| match zen_screen_vocab::raw_snapshot() {
        Ok(text) => Ok(zen_screen_vocab::extract::extract_vocab(
            &text,
            zen_screen_vocab::DEFAULT_MAX_TERMS,
        )),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking: {e}")))?;

    Ok(match result {
        Ok(terms) => ScreenVocabPreviewDto {
            supported: true,
            terms,
            error: None,
        },
        Err(msg) => ScreenVocabPreviewDto {
            supported: true,
            terms: Vec::new(),
            error: Some(msg),
        },
    })
}

/// Toggle the screen-vocabulary feature. When enabled, each
/// dictation recording is paired with a background OCR pass over
/// the current screen; the recognised vocabulary is fed to the
/// active backend as a contextual hint (Apple Speech
/// `contextualStrings` / Whisper `initial_prompt`).
///
/// Persisted via `SCREEN_VOCAB_KEY`. The first opt-in is what
/// triggers the macOS Screen Recording TCC prompt — we don't
/// pre-prompt because (1) prompting before the user opts in is
/// confusing, and (2) ScreenCaptureKit issues the prompt itself the
/// first time it tries to capture.
#[tauri::command]
pub async fn dictation_set_screen_vocab(
    enabled: bool,
    app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    state.manager.set_screen_vocab_enabled(enabled);
    if let Some(cfg) = app.try_state::<UserConfig>() {
        if let Err(e) = cfg.set(SCREEN_VOCAB_KEY, &enabled) {
            tracing::warn!(?e, "dictation: persist screen_vocab_enabled failed");
        }
    }
    Ok(())
}

/// Wipe the Screen Recording TCC entry for our bundle id and trigger
/// a fresh OCR snapshot so the system prompt fires again.
///
/// Mirrors `dictation_reset_accessibility` but for the
/// `kTCCServiceScreenCapture` service. There's no Apple-provided
/// "ask politely for screen recording" API equivalent to
/// `AXIsProcessTrustedWithOptions(prompt: true)` — the only way to
/// surface the system dialog is to actually attempt a capture, which
/// macOS intercepts via the TCC trampoline. So we shell out to
/// `tccutil reset ScreenCapture <bundle>` and then immediately kick
/// off a snapshot in the background; the user will see the system
/// dialog appear within a fraction of a second.
///
/// Same dev-vs-bundled caveat applies as accessibility: in a
/// `cargo tauri dev` build the cdhash differs from any release build
/// the user previously granted, so the tccutil reset will succeed
/// but a brand-new entry will be created against the dev binary's
/// cdhash — that grant evaporates on next rebuild. Bundled builds
/// follow the full reset+prompt path normally.
#[tauri::command]
pub async fn dictation_reset_screen_recording(app: AppHandle) -> AppResult<()> {
    let bundle_id = app.config().identifier.clone();
    crate::dictation::permissions::reset_tcc_entry("ScreenCapture", &bundle_id)
        .map_err(AppError::Other)?;

    if crate::dictation::permissions::is_running_inside_app_bundle() {
        // Run a one-shot snapshot on a worker so the TCC trampoline
        // gets invoked and the system prompt appears. We don't care
        // about the result — the side effect of triggering the
        // prompt is the whole point.
        tauri::async_runtime::spawn_blocking(|| {
            let _ = zen_screen_vocab::raw_snapshot();
        });
    } else {
        tracing::info!(
            "dictation: reset_screen_recording — TCC entry wiped, but running \
             outside an .app bundle so skipping the in-process re-prompt. Grant \
             via the bundled build to make it stick across rebuilds."
        );
    }
    Ok(())
}

/// Reveal `<app_data_dir>/` in Finder.
#[tauri::command]
pub async fn dictation_open_app_data_dir(
    _app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    open_path_in_finder(&state.app_data_dir).await
}

/// Reveal `<app_data_dir>/logs/` in Finder.
#[tauri::command]
pub async fn dictation_open_logs_dir(
    _app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    open_path_in_finder(&state.logs_dir).await
}

/// Reveal `<app_data_dir>/models/` in Finder.
#[tauri::command]
pub async fn dictation_open_models_dir(
    _app: AppHandle,
    state: State<'_, DictationTauriState>,
) -> AppResult<()> {
    open_path_in_finder(&state.models_dir).await
}

/// `true` only on platforms where local dictation can actually run.
///
/// The vendored `whisper.cpp` build only ships the Metal + Accelerate
/// backends today, so non-macOS targets compile but always return
/// `WhisperError::NotSupported` at runtime. Front-end code uses this
/// command to hide the Dictation Settings section entirely on
/// Linux/Windows — there's nothing for the user to do with it there.
#[tauri::command]
pub async fn dictation_is_supported() -> AppResult<bool> {
    Ok(cfg!(target_os = "macos"))
}

/// Read-only DTO for the Paths section in Settings.
#[tauri::command]
pub async fn dictation_get_paths(state: State<'_, DictationTauriState>) -> AppResult<PathsDto> {
    Ok(PathsDto {
        app_data_dir: state.app_data_dir.display().to_string(),
        logs_dir: state.logs_dir.display().to_string(),
        models_dir: state.models_dir.display().to_string(),
    })
}

/// Snapshot of the macOS TCC permissions dictation cares about.
/// Both fields are tri-state-ish: `Some(true)` granted,
/// `Some(false)` an entry exists in TCC but is denied (or no entry
/// has ever been created and the call hasn't prompted yet — the two
/// look the same to `AXIsProcessTrusted` / AVAuthorization), `None`
/// when the platform doesn't support the check (non-macOS).
#[derive(Debug, serde::Serialize)]
pub struct PermissionsDto {
    /// Whether the macOS Accessibility TCC entry currently grants
    /// access. `None` on non-macOS targets where TCC doesn't exist;
    /// `Some(false)` when the entry is missing OR explicitly denied
    /// (the two states look identical to `AXIsProcessTrusted`).
    pub accessibility_granted: Option<bool>,
    /// Microphone authorization state from
    /// `AVCaptureDevice.authorizationStatus(for: .audio)`. Mirrors
    /// `MicAuthStatus::as_wire_str` exactly: `"notDetermined" |
    /// "restricted" | "denied" | "authorized"`. `None` on non-macOS.
    pub microphone_status: Option<String>,
    /// Whether the auto-recovery flow has decided the current
    /// Accessibility-denied state is a deliberate revocation (same
    /// install id as the last observed grant). The UI uses this to
    /// distinguish "we tried to auto-fix but the user revoked" from
    /// "we haven't auto-fixed yet" — the banner stays out of the way
    /// in the second case.
    pub accessibility_deliberate_denial: bool,
    /// Same idea for microphone.
    pub microphone_deliberate_denial: bool,
}

/// Probe the current Accessibility + Microphone permission state.
/// Cheap (one syscall + one objc msg-send); the UI re-fetches on
/// window focus / `dictation:permissions-changed` event so changes
/// the user just made in System Settings reflect without a manual
/// refresh.
#[tauri::command]
pub async fn dictation_get_permissions(app: AppHandle) -> AppResult<PermissionsDto> {
    if !cfg!(target_os = "macos") {
        return Ok(PermissionsDto {
            accessibility_granted: None,
            microphone_status: None,
            accessibility_deliberate_denial: false,
            microphone_deliberate_denial: false,
        });
    }

    let ax_granted = crate::dictation::permissions::is_accessibility_trusted();
    let mic_status = crate::dictation::permissions::microphone_authorization_status();

    // Cross-reference with the persisted install-id record to
    // surface "deliberate denial" vs "stuck stale entry" so the UI
    // banner can phrase its copy accordingly.
    let cfg = app.state::<UserConfig>();
    let current = crate::dictation::install_id::current(&app);
    let prior = crate::dictation::install_id::read(cfg.inner())
        .ok()
        .flatten()
        .unwrap_or_default();

    let ax_deliberate = !ax_granted
        && prior
            .accessibility
            .as_ref()
            .map(|r| r.install_id == current)
            .unwrap_or(false);

    let mic_denied = mic_status == crate::dictation::permissions::MicAuthStatus::Denied;
    let mic_deliberate = mic_denied
        && prior
            .microphone
            .as_ref()
            .map(|r| r.install_id == current)
            .unwrap_or(false);

    Ok(PermissionsDto {
        accessibility_granted: Some(ax_granted),
        microphone_status: Some(mic_status.as_wire_str().to_string()),
        accessibility_deliberate_denial: ax_deliberate,
        microphone_deliberate_denial: mic_deliberate,
    })
}

/// Wipe the Accessibility TCC entry for our bundle id and trigger
/// the system prompt afresh, so the user can grant without having to
/// know about `tccutil` or hunt through System Settings.
///
/// In a dev build (raw `target/debug/zen-tools`, no `.app` bundle)
/// the TCC entry is keyed off a different cdhash than any installed
/// release, so `tccutil reset` is a no-op against the dev binary.
/// We still run it (cheap, harmless) but skip
/// `prompt_accessibility()` — the prompting variant of
/// `AXIsProcessTrustedWithOptions` is safe to call without a bundle,
/// but it would key the resulting grant against the dev binary's
/// cdhash and that grant evaporates on next rebuild. Bundled builds
/// follow the full reset+prompt path.
#[tauri::command]
pub async fn dictation_reset_accessibility(app: AppHandle) -> AppResult<()> {
    let bundle_id = app.config().identifier.clone();
    crate::dictation::permissions::reset_tcc_entry("Accessibility", &bundle_id)
        .map_err(AppError::Other)?;
    if crate::dictation::permissions::is_running_inside_app_bundle() {
        let _ = crate::dictation::permissions::prompt_accessibility();
        crate::dictation::lifecycle::start(&app);
    } else {
        tracing::info!(
            "dictation: reset_accessibility — TCC entry wiped, but running \
             outside an .app bundle so skipping the in-process re-prompt. \
             Grant via the bundled build to make it stick across rebuilds."
        );
    }
    Ok(())
}

/// Wipe the Microphone TCC entry for our bundle id. The user
/// triggers the actual prompt themselves by starting a recording —
/// AVCaptureDevice's first capture-attempt is what shows the system
/// "Zen Tools would like to access the microphone" dialog. We can't
/// fire that dialog standalone safely (calling
/// `requestAccessForMediaType:` without an Info.plist usage-description
/// terminates the process), so the UX is: click Reset → next dictation
/// gesture re-prompts via cpal/CoreAudio's separate enforcement path.
#[tauri::command]
pub async fn dictation_reset_microphone(app: AppHandle) -> AppResult<()> {
    let bundle_id = app.config().identifier.clone();
    crate::dictation::permissions::reset_tcc_entry("Microphone", &bundle_id)
        .map_err(AppError::Other)
}

/// Deep-link into the Accessibility / Microphone privacy pane in
/// System Settings. Convenience for when the user wants to inspect
/// or toggle the entry directly rather than reset it.
#[tauri::command]
pub async fn dictation_open_privacy_pane(pane: String) -> AppResult<()> {
    crate::dictation::permissions::open_privacy_pane(&pane).map_err(AppError::Other)
}

/// Open `path` as a folder in Finder.
///
/// We deliberately bypass `tauri-plugin-shell`'s `Shell::open`. That
/// plugin's `shell:allow-open` permission validates targets against a
/// regex that defaults to URL schemes only (`https?://`, `mailto:`,
/// `tel:`) — local filesystem paths fail validation silently.
///
/// History — and why this is osascript, not `open(1)`:
///
/// The original implementation used `open -a Finder <path>`. Under
/// the previous bundle id `com.zen-tools.app`, the app-data dir
/// path ended in `.app`, and Finder would (despite the explicit
/// `-a Finder`) honour the `.app` suffix as "this is an application
/// bundle to launch" rather than "this is a folder to open". That
/// either errored out ("the application cannot be opened because
/// its executable is missing") or, in some macOS versions, locked
/// up Finder entirely.
///
/// The bundle id is now `com.seg4lt.zen-tools` (no `.app` suffix),
/// so the `open(1)` heuristic wouldn't trip today — but we still
/// use osascript here because:
///
///   1. It's unambiguous: "tell Finder to open this POSIX file"
///      bypasses every suffix-based heuristic in `open(1)` and in
///      Finder's own routing logic. Future bundle-id changes can't
///      regress us.
///   2. Same code path works for `Open in Finder` on the Logs and
///      Models dirs, which today don't have `.app`-suffixed names
///      but might one day live under a path that does.
///
/// We `create_dir_all` first so a click on "Logs" right after a
/// fresh install (before any log line has rotated to disk) still
/// opens the folder instead of erroring.
pub(crate) async fn open_path_in_finder(path: &Path) -> AppResult<()> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| {
            AppError::Other(format!("create {}: {}", path.display(), e))
        })?;
    }
    let path_owned = path.to_path_buf();
    tracing::info!(path = %path_owned.display(), "dictation: opening folder in Finder");
    tokio::task::spawn_blocking(move || {
        // Build the AppleScript: `tell application "Finder" to open
        // POSIX file "<path>"`. POSIX paths can legally contain
        // double-quotes and backslashes — escape both before
        // interpolating into the script string.
        let escaped = path_owned
            .display()
            .to_string()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let script = format!(
            "tell application \"Finder\" to open POSIX file \"{}\"",
            escaped
        );

        let output = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| AppError::Other(format!("spawn osascript: {e}")))?;

        if output.status.success() {
            Ok(())
        } else {
            // Fall back to `open -R` (reveal — selects the target in
            // its parent dir) so the user at least gets near the
            // folder they asked for, even if direct-open via
            // osascript failed. Not great UX (one extra click),
            // but strictly better than a silent error.
            let osa_stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            tracing::warn!(
                status = ?output.status,
                stderr = %osa_stderr,
                path = %path_owned.display(),
                "dictation: osascript open failed; falling back to `open -R`"
            );
            let reveal = std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(path_owned.as_os_str())
                .output()
                .map_err(|e| AppError::Other(format!("spawn open -R: {e}")))?;
            if reveal.status.success() {
                Ok(())
            } else {
                let reveal_stderr =
                    String::from_utf8_lossy(&reveal.stderr).into_owned();
                tracing::warn!(
                    status = ?reveal.status,
                    stderr = %reveal_stderr,
                    path = %path_owned.display(),
                    "dictation: open -R fallback also failed"
                );
                Err(AppError::Other(format!(
                    "open {} failed: osascript={}; open -R={}",
                    path_owned.display(),
                    osa_stderr.trim(),
                    reveal_stderr.trim()
                )))
            }
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking: {e}")))?
}
