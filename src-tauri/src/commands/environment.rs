//! Environment + extracted-vars + cookies commands.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use ahash::HashMap;
use std::path::PathBuf;
use tokio::sync::Mutex;
use zen_parser::parse_env_file;
use zen_types::prelude::*;

/// All environment names available across the loaded global + local env
/// files (deduplicated, sorted).
#[tauri::command]
pub async fn list_environments(state: tauri::State<'_, Mutex<AppState>>) -> AppResult<Vec<String>> {
    let s = state.lock().await;
    let mut names: Vec<String> = Vec::new();
    if let Some(file) = &s.global_env_file {
        names.extend(file.env_names());
    }
    if let Some(file) = &s.local_env_file {
        names.extend(file.env_names());
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// Set the active environment.
#[tauri::command]
pub async fn set_active_environment(
    env_name: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    state.lock().await.selected_env = Some(EnvName::new(env_name));
    Ok(())
}

/// Read the active environment.
#[tauri::command]
pub async fn get_active_environment(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Option<String>> {
    Ok(state
        .lock()
        .await
        .selected_env
        .as_ref()
        .map(|e| e.as_str().to_string()))
}

/// Merged env-var map for the currently-selected environment.
#[tauri::command]
pub async fn get_env_vars(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<HashMap<String, String>> {
    Ok(state.lock().await.current_env_vars())
}

/// Extracted-vars map for the current environment.
#[tauri::command]
pub async fn get_extracted_vars(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<HashMap<String, String>> {
    Ok(state.lock().await.current_extracted_vars())
}

/// Insert/update a single extracted variable for the current environment.
#[tauri::command]
pub async fn set_extracted_var(
    key: String,
    value: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let mut s = state.lock().await;
    let env_key = s.env_key();
    s.extracted_vars
        .entry(env_key)
        .or_default()
        .insert(key, value);
    Ok(())
}

/// Drop a single extracted variable for the current environment.
#[tauri::command]
pub async fn delete_extracted_var(
    key: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let mut s = state.lock().await;
    let env_key = s.env_key();
    if let Some(map) = s.extracted_vars.get_mut(&env_key) {
        map.remove(&key);
    }
    Ok(())
}

/// Drop every extracted variable for the current environment.
#[tauri::command]
pub async fn clear_extracted_vars(state: tauri::State<'_, Mutex<AppState>>) -> AppResult<()> {
    let mut s = state.lock().await;
    let env_key = s.env_key();
    s.extracted_vars.remove(&env_key);
    Ok(())
}

/// Cookie pairs for the current environment.
#[tauri::command]
pub async fn get_cookies(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<(String, String)>> {
    Ok(state.lock().await.current_cookies())
}

/// Drop every cookie for the current environment.
#[tauri::command]
pub async fn clear_cookies(state: tauri::State<'_, Mutex<AppState>>) -> AppResult<()> {
    let mut s = state.lock().await;
    let env_key = s.env_key();
    s.cookies.remove(&env_key);
    Ok(())
}

/// Load an env file from disk, replacing the global env in state.
#[tauri::command]
pub async fn load_env_file(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<String>> {
    let path = PathBuf::from(&path);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::BadRequest(format!("read env file: {e}")))?;
    let env = parse_env_file(path, &content)?;
    let names = env.env_names();
    state.lock().await.global_env_file = Some(env);
    Ok(names)
}
