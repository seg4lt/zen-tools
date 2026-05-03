//! HTTP-file open/read/write/reload commands.

use crate::dto::{EnvironmentFileDto, OpenedHttpFileDto};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use tracing::debug;
use zen_parser::{find_env_file, parse_env_file, pick_default_env_name};
use zen_types::prelude::*;

/// Open an `.http` file, register it in the cache, and resolve any
/// directory-local env file. If no environment is currently selected
/// but the file's local env contains some, **auto-select a default**
/// (`development` → `dev` → first alphabetical) and surface the
/// chosen name so the front-end can refresh its env-aware queries.
#[tauri::command]
pub async fn open_http_file(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<OpenedHttpFileDto> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(AppError::BadRequest(format!("file not found: {path}")));
    }

    let registry = state.lock().await.file_registry.clone();
    let arc_file = registry.get_or_load(&path_buf)?;

    // Look for a local env file alongside the http file.
    let mut local_env_dto = None;
    let mut auto_selected_env: Option<String> = None;
    if let Some(parent) = path_buf.parent() {
        if let Some(env_path) = find_env_file(parent) {
            if let Ok(content) = std::fs::read_to_string(&env_path) {
                match parse_env_file(env_path.clone(), &content) {
                    Ok(env) => {
                        let names = env.env_names();
                        local_env_dto = Some(EnvironmentFileDto::from(&env));
                        let mut s = state.lock().await;
                        s.local_env_file = Some(env);
                        // If no env is selected (the project root
                        // didn't contain an env file so add_working_dir
                        // couldn't auto-pick one), do it now from
                        // whatever the file's directory contributed.
                        // Without this, `{{host}}` etc. stay raw on
                        // the Sent tab even though the env file is
                        // sitting right there.
                        if s.selected_env.is_none() {
                            if let Some(name) = pick_default_env_name(&names) {
                                s.selected_env = Some(EnvName::new(name.clone()));
                                auto_selected_env = Some(name);
                            }
                        }
                    }
                    Err(e) => debug!(?e, "failed to parse local env file"),
                }
            }
        }
    }

    Ok(OpenedHttpFileDto {
        file: (*arc_file).clone(),
        local_env: local_env_dto,
        auto_selected_env,
    })
}

/// Read raw file contents — used by the editor.
#[tauri::command]
pub async fn read_file_content(path: String) -> AppResult<String> {
    let content = std::fs::read_to_string(Path::new(&path))?;
    Ok(content)
}

/// Save file contents and invalidate the parse cache for this path.
#[tauri::command]
pub async fn write_file_content(
    path: String,
    content: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let path_buf = PathBuf::from(&path);
    std::fs::write(&path_buf, content)?;
    state.lock().await.file_registry.invalidate(&path_buf);
    Ok(())
}

/// Force a re-parse from disk and return the fresh structure.
#[tauri::command]
pub async fn reload_http_file(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<OpenedHttpFileDto> {
    let path_buf = PathBuf::from(&path);
    let registry = state.lock().await.file_registry.clone();
    registry.invalidate(&path_buf);
    let arc_file = registry.get_or_load(&path_buf)?;
    Ok(OpenedHttpFileDto {
        file: (*arc_file).clone(),
        local_env: None,
        auto_selected_env: None,
    })
}
