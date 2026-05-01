//! Tauri application library entrypoint.
//!
//! Composes the workspace crates (`zen-types`, `zen-parser`, `zen-http`,
//! `zen-perf`) and exposes them to the React front-end via Tauri commands.

#![warn(missing_docs)]

pub mod commands;
pub mod dto;
pub mod error;
pub mod schema_cache;
pub mod state;
pub mod tray;
pub mod user_config;

use commands::markdown_index::MarkdownIndexRegistry;
use commands::runs::{load_runs, RunHistory};
use schema_cache::SchemaCache;
use state::AppState;
use user_config::UserConfig;
use std::sync::Arc;
use tauri::{Emitter, Manager};
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
        .manage(Mutex::new(RunHistory::default()))
        // fff-search per-vault file pickers.  Lazily populated on
        // the first search call; `markdown_remove_vault` drops the
        // entry so the bg watcher / fs handles get released.
        // Wrapped in `Arc` so command handlers can clone cheaply.
        .manage(Arc::new(MarkdownIndexRegistry::default()))
        .setup(|app| {
            // Open the user-config store FIRST so subsequent setup
            // steps (and every command path) can read settings via
            // `commands::preferences::load_preferences`. Registering
            // before `load_runs` is overkill today (runs.rs reads its
            // own file) but keeps the invariant simple: settings are
            // available from this point onward.
            match UserConfig::open(app.handle()) {
                Ok(cfg) => {
                    app.manage(cfg);
                }
                Err(e) => {
                    // Non-fatal — `load_preferences` falls back to
                    // defaults when the store is missing, so the app
                    // still launches; the user just sees a fresh state.
                    tracing::warn!(?e, "user_config: open failed; settings will use defaults");
                }
            }

            // Hydrate run history from disk so previous-session runs
            // are immediately available in the History tab.
            let store = app.state::<Mutex<RunHistory>>();
            let mut s = store.blocking_lock();
            load_runs(app.handle(), &mut s);
            drop(s);

            // Open (or create) the SQL-autocomplete schema cache. Held
            // as managed state so commands can clone the `Arc` cheaply
            // without touching the outer `Mutex<AppState>`.
            match SchemaCache::open(app.handle()) {
                Ok(cache) => {
                    app.manage(cache);
                }
                Err(e) => {
                    tracing::warn!(?e, "schema_cache: open failed; auto-complete will be live-only");
                }
            }

            // ── Process Monitor: spawn the sampler thread + the broadcast
            // → Tauri-event bridge. The sampler skips work whenever no
            // PIDs are configured, so it's cheap to leave running.
            let (pm_state, pm_tx) = {
                let app_state = app.state::<Mutex<AppState>>();
                let s = app_state.blocking_lock();
                (s.pm_state.clone(), s.pm_handle.tx.clone())
            };
            let sampler_state = pm_state.clone();
            let sampler_tx = pm_tx.clone();
            std::thread::Builder::new()
                .name("zen-process-monitor-sampler".into())
                .spawn(move || {
                    zen_process_monitor::run_sampler(sampler_state, sampler_tx);
                })
                .expect("spawn sampler thread");

            // Broadcast → Tauri event bridge. Subscribers in the React
            // frontend listen for `pm:sample`.
            let app_handle = app.handle().clone();
            let mut rx = pm_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(sample) => {
                            let _ = app_handle.emit("pm:sample", &sample);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            // Frontend will rehydrate via pm_get_history.
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // files
            commands::files::discover_http_files,
            commands::files::find_env_file_command,
            commands::files::add_working_dir,
            commands::files::remove_working_dir,
            commands::files::list_working_dirs,
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
            // preferences
            commands::preferences::get_preferences,
            commands::preferences::save_preferences,
            // run history
            commands::runs::record_run,
            commands::runs::get_run_history,
            commands::runs::clear_run_history,
            // process monitor
            commands::process_monitor::pm_list_processes,
            commands::process_monitor::pm_add_target,
            commands::process_monitor::pm_remove_target,
            commands::process_monitor::pm_set_targets,
            commands::process_monitor::pm_clear_targets,
            commands::process_monitor::pm_get_config,
            commands::process_monitor::pm_get_history,
            commands::process_monitor::pm_set_poll_interval,
            // cleaner
            commands::cleaner::cleaner_list_scan_folders,
            commands::cleaner::cleaner_add_scan_folder,
            commands::cleaner::cleaner_remove_scan_folder,
            commands::cleaner::cleaner_scan_folder,
            commands::cleaner::cleaner_discover_globals,
            commands::cleaner::cleaner_run_actions,
            commands::cleaner::cleaner_get_cached_tree,
            // markdown
            commands::markdown::markdown_list_vaults,
            commands::markdown::markdown_add_vault,
            commands::markdown::markdown_remove_vault,
            commands::markdown::markdown_discover_files,
            commands::markdown::markdown_recent_files,
            commands::markdown::markdown_push_recent,
            commands::markdown::markdown_save_pasted_image,
            commands::markdown::markdown_create_file,
            commands::markdown::markdown_create_dir,
            commands::markdown::markdown_rename,
            commands::markdown::markdown_delete_to_trash,
            commands::markdown::markdown_search_contents,
            commands::markdown::markdown_search_files,
            commands::markdown::markdown_stop_content_search,
            commands::markdown::markdown_copy_svg_as_png,
            // database explorer
            commands::database::db_test_connection,
            commands::database::db_save_connection,
            commands::database::db_delete_connection,
            commands::database::db_list_saved_connections,
            commands::database::db_connect,
            commands::database::db_disconnect,
            commands::database::db_list_databases,
            commands::database::db_list_schemas,
            commands::database::db_list_tables,
            commands::database::db_list_all_tables,
            commands::database::db_list_routines,
            commands::database::db_query,
            commands::database::db_describe_table,
            commands::database::db_describe_tables_bulk,
            commands::database::db_list_cached_tables,
            commands::database::db_invalidate_schema_cache,
            // sql workspace (database explorer file tree)
            commands::sql_workspace::sql_workspace_list,
            commands::sql_workspace::sql_workspace_add,
            commands::sql_workspace::sql_workspace_remove,
            commands::sql_workspace::sql_workspace_discover,
            commands::sql_workspace::sql_workspace_create_file,
            commands::sql_workspace::sql_workspace_create_dir,
            commands::sql_workspace::sql_workspace_rename,
            commands::sql_workspace::sql_workspace_delete_to_trash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
