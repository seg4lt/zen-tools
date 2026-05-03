//! Tauri commands invoked by the frontend.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};
use zen_dictation::ModelId;

use crate::dictation::dto::{DictationStateDto, ModelDto, PathsDto};
use crate::dictation::state::DictationTauriState;
use crate::dictation::SELECTED_MODEL_KEY;
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
    Ok(DictationStateDto {
        selected_model: selected,
        models,
        is_recording: state.manager.is_recording(),
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

/// Open `path` in Finder via the macOS `open(1)` command.
///
/// We deliberately bypass `tauri-plugin-shell`'s `Shell::open`. That
/// plugin's `shell:allow-open` permission validates targets against a
/// regex that defaults to URL schemes only (`https?://`, `mailto:`,
/// `tel:`) — local filesystem paths fail validation silently.
///
/// **Important:** the bundle identifier is `com.zen-tools.app`, so
/// the app-data directory is literally named `com.zen-tools.app/`.
/// `open <dir>` checks for `.app` suffixes and tries to launch the
/// path as an application bundle — which fails with `"the
/// application cannot be opened because its executable is missing"`.
/// We pass `-a Finder` to force Finder as the opener and skip the
/// bundle heuristic. `-R` (reveal) would also work but it shows the
/// folder selected inside its parent rather than opening it; `-a
/// Finder` opens the folder window itself, which is what users
/// expect for a "Show on disk" affordance.
///
/// We also `create_dir_all` first so a click on "Logs" right after a
/// fresh install (before any log line has rotated to disk) still
/// opens the folder instead of erroring.
async fn open_path_in_finder(path: &Path) -> AppResult<()> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| {
            AppError::Other(format!("create {}: {}", path.display(), e))
        })?;
    }
    let path_owned = path.to_path_buf();
    tracing::info!(path = %path_owned.display(), "dictation: opening folder in Finder");
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("/usr/bin/open")
            .arg("-a")
            .arg("Finder")
            .arg(path_owned.as_os_str())
            .output()
            .map_err(|e| AppError::Other(format!("spawn open: {e}")))?;
        if output.status.success() {
            Ok(())
        } else {
            // Capture stderr so the failure is visible in our log
            // file — `open(1)` writes its diagnostics there
            // (e.g. "the application cannot be opened…").
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            tracing::warn!(
                status = ?output.status,
                stderr = %stderr,
                path = %path_owned.display(),
                "dictation: open command failed"
            );
            Err(AppError::Other(format!(
                "open {} failed: {}",
                path_owned.display(),
                stderr.trim()
            )))
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("spawn_blocking: {e}")))?
}
