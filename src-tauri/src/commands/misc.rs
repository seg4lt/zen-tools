//! Miscellaneous commands that don't fit elsewhere.

use crate::error::AppResult;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Open a file in the user's default `$EDITOR` / `$VISUAL`. Falls back to
/// the OS-native open behaviour when neither is set.
#[tauri::command]
pub async fn open_in_editor(path: String, app_handle: AppHandle) -> AppResult<()> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "open".to_string());

    let _ = app_handle
        .shell()
        .command(editor)
        .args([path.as_str()])
        .spawn();

    Ok(())
}
