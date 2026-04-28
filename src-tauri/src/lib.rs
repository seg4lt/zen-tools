//! Tauri application library entrypoint.
//!
//! Composes the workspace crates (`zen-types`, `zen-parser`, `zen-http`,
//! `zen-perf`) and exposes them to the React front-end via Tauri commands.

use tracing_subscriber::EnvFilter;

/// Initialise the Tauri app. Called from `main.rs` and from mobile entry
/// points.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,zen=debug")),
        )
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Smoke-test command — replaced in later phases.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! Welcome to Zen Tools.")
}
