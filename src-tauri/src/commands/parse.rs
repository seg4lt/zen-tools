//! HTTP-file open/read/write/reload commands.

use crate::dto::{EnvironmentFileDto, OpenedHttpFileDto};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use tracing::debug;
use zen_parser::{find_env_file, parse_env_file};

/// Open an `.http` file, register it in the cache, and resolve any
/// directory-local env file.
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
    if let Some(parent) = path_buf.parent() {
        if let Some(env_path) = find_env_file(parent) {
            if let Ok(content) = std::fs::read_to_string(&env_path) {
                match parse_env_file(env_path.clone(), &content) {
                    Ok(env) => {
                        local_env_dto = Some(EnvironmentFileDto::from(&env));
                        state.lock().await.local_env_file = Some(env);
                    }
                    Err(e) => debug!(?e, "failed to parse local env file"),
                }
            }
        }
    }

    Ok(OpenedHttpFileDto {
        file: (*arc_file).clone(),
        local_env: local_env_dto,
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
    })
}
