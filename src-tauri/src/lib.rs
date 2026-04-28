//! Tauri application library entrypoint.
//!
//! Composes the workspace crates (`zen-types`, `zen-parser`, `zen-http`,
//! `zen-perf`) and exposes them to the React front-end via Tauri commands.

#![warn(missing_docs)]

pub mod commands;
pub mod dto;
pub mod error;
pub mod state;

use state::AppState;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

/// Initialise the Tauri app. Called from `main.rs` and from mobile entry
/// points.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,zen=debug")),
        )
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Mutex::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            // files
            commands::files::discover_http_files,
            commands::files::discover_perf_files,
            commands::files::find_env_file_command,
            commands::files::set_working_dir,
            commands::files::get_working_dir,
            commands::files::pick_directory,
            // parse
            commands::parse::open_http_file,
            commands::parse::read_file_content,
            commands::parse::write_file_content,
            commands::parse::reload_http_file,
            // environment
            commands::environment::list_environments,
            commands::environment::set_active_environment,
            commands::environment::get_active_environment,
            commands::environment::get_env_vars,
            commands::environment::get_extracted_vars,
            commands::environment::set_extracted_var,
            commands::environment::delete_extracted_var,
            commands::environment::clear_extracted_vars,
            commands::environment::get_cookies,
            commands::environment::clear_cookies,
            commands::environment::load_env_file,
            // execute
            commands::execute::run_request,
            commands::execute::run_request_with_deps,
            commands::execute::build_curl_command,
            // perf
            commands::perf::load_perf_config,
            commands::perf::run_perf_test,
            commands::perf::stop_perf_test,
            commands::perf::export_perf_results,
            commands::perf::get_perf_metrics,
            // misc
            commands::misc::open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
