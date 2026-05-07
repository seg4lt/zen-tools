//! Miscellaneous commands that don't fit elsewhere.

use crate::error::AppResult;
use tauri::{AppHandle, Manager};
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

/// Hide the main window and drop the Dock icon (Accessory activation policy).
///
/// Called by the frontend when `app:close-requested` is received and there
/// is nothing tool-specific to handle (e.g. no markdown tab to close).
/// Mirrors the behaviour that was previously hard-coded inside the Rust
/// `CloseRequested` handler.
#[tauri::command]
pub async fn app_hide_main_window(app_handle: AppHandle) -> AppResult<()> {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    Ok(())
}
