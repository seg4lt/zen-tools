//! Tauri application library entrypoint.
//!
//! Composes the workspace crates (`zen-types`, `zen-parser`, `zen-http`,
//! `zen-perf`) and exposes them to the React front-end via Tauri commands.

#![warn(missing_docs)]

pub mod commands;
pub mod dto;
pub mod error;
pub mod prmaster_tray;
pub mod schema_cache;
pub mod state;
pub mod tray;
pub mod user_config;

use commands::markdown_index::MarkdownIndexRegistry;
use commands::runs::{load_runs, RunHistory};
use state::AppState;
use user_config::UserConfig;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

/// Build the `tauri-plugin-global-shortcut` plugin with the PRMaster hotkey
/// handler baked in. The handler matches against the chord we register in
/// `setup` and brings the main window forward + emits `prmaster:focus-route`
/// so the React router navigates regardless of where the user was.
fn build_global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
    let prmaster_chord = Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        Code::KeyP,
    );
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, sc, ev| {
            if ev.state() != ShortcutState::Pressed {
                return;
            }
            if sc == &prmaster_chord {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    #[cfg(target_os = "macos")]
                    {
                        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                    }
                    let _ = app.emit("prmaster:focus-route", "/prmaster");
                });
            }
        })
        .build()
}

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
        // tauri-plugin-fs intentionally NOT registered — every local
        // file the frontend reads/writes goes through `read_file_content`
        // / `write_file_content` Tauri commands (which call into the
        // crate layer with explicit path validation), and the
        // markdown live-preview's `<img src=…>` paths use
        // `convertFileSrc()` over the **asset protocol** (separate
        // Tauri feature `protocol-asset`, configured in
        // `tauri.conf.json::security.assetProtocol`). The fs plugin
        // would let arbitrary frontend code touch arbitrary paths
        // without going through our wrappers — strictly tighter to
        // omit it.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(build_global_shortcut_plugin())
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
            match user_config::open(app.handle()) {
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
            match schema_cache::open(app.handle()) {
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

            // ── PRMaster: build the always-present tray. The tray exists for
            // the lifetime of the app (matching PRMaster's `MenuBarExtra`).
            // Failing to build it isn't fatal — the app still works as a
            // window-only multi-tool.
            if let Err(e) = prmaster_tray::init(app.handle()) {
                tracing::warn!(?e, "prmaster_tray::init failed");
            }

            // PRMaster broadcast → Tauri-event bridge. Subscribes to the
            // engine's broadcast channel, re-emits each event for the
            // frontend, updates the tray badge on `BadgeChanged`, and
            // dispatches `Notification` events through the macOS
            // notification centre via `tauri-plugin-notification`.
            let prmaster_engine = {
                let app_state = app.state::<Mutex<AppState>>();
                let s = app_state.blocking_lock();
                s.prmaster.clone()
            };
            let mut prmaster_rx = prmaster_engine.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_notification::NotificationExt;
                use zen_prmaster::PrMasterEvent;
                loop {
                    match prmaster_rx.recv().await {
                        Ok(PrMasterEvent::Refreshed(snapshot)) => {
                            let _ = app_handle.emit("prmaster:refreshed", &snapshot);
                            // Persist the latest snapshot so the next
                            // cold start hydrates from disk instead of
                            // showing an empty list until the first
                            // poll completes (Swift `CacheService`).
                            let cfg = app_handle.state::<UserConfig>();
                            commands::prmaster::persist_pr_snapshot(
                                cfg.inner(),
                                &snapshot,
                            );
                        }
                        Ok(PrMasterEvent::BadgeChanged(text)) => {
                            prmaster_tray::set_badge(&app_handle, &text);
                            let _ = app_handle.emit("prmaster:badge-changed", &text);
                        }
                        Ok(PrMasterEvent::Notification(note)) => {
                            let _ = app_handle.emit("prmaster:notification", &note);
                            // Suppress badge-only / muted entries here too —
                            // they should never reach the system notification
                            // centre. (The engine already filters muted; this
                            // is belt-and-braces.)
                            if note.badge_only || note.muted {
                                continue;
                            }
                            let mut builder = app_handle
                                .notification()
                                .builder()
                                .title(&note.title)
                                .body(&note.body);
                            if note.silent {
                                builder = builder.sound("");
                            }
                            if let Err(e) = builder.show() {
                                tracing::warn!(?e, "notification show failed");
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // Spawn the 5-minute background refresh (mirrors PRMaster's
            // hardcoded `Timer.scheduledTimer(withTimeInterval: 300)`).
            // Uses `tauri::async_runtime::spawn` so it works regardless of
            // whether `setup` runs inside a tokio worker — `tokio::spawn`
            // panics when called from the AppKit main thread that Tauri
            // hands `setup` to during launch.
            //
            // Also kicks an immediate refresh so the menu-bar badge isn't
            // empty until the user opens the popover.
            let bg_engine = prmaster_engine.clone();
            let bg_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use std::time::Duration;

                // Immediate first refresh — load whatever settings the
                // user has already saved (badge configs included), so the
                // tray populates as soon as gh data lands.
                let initial_settings = {
                    let cfg = bg_app.state::<crate::user_config::UserConfig>();
                    cfg.get::<zen_prmaster::PrMasterSettings>("prmaster")
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                };
                if let Err(e) = bg_engine
                    .refresh_lists_and_notify(&initial_settings)
                    .await
                {
                    tracing::warn!(error = %e, "initial refresh failed");
                }

                let mut tick = tokio::time::interval(Duration::from_secs(300));
                tick.tick().await; // skip immediate first tick
                loop {
                    tick.tick().await;
                    let settings = {
                        let cfg = bg_app.state::<crate::user_config::UserConfig>();
                        cfg.get::<zen_prmaster::PrMasterSettings>("prmaster")
                            .ok()
                            .flatten()
                            .unwrap_or_default()
                    };
                    if let Err(e) = bg_engine
                        .refresh_lists_and_notify(&settings)
                        .await
                    {
                        tracing::warn!(error = %e, "background refresh failed");
                    }
                }
            });

            // Background-agent lifecycle: when the user closes the main
            // window we keep the process alive (so polling continues) and
            // drop the Dock icon by switching to `Accessory` activation
            // policy. Re-opening (via tray menu / hotkey / `prmaster_open_full_window`
            // command) flips it back to `Regular`.
            #[cfg(target_os = "macos")]
            {
                let app_handle = app.handle().clone();
                if let Some(main) = app.get_webview_window("main") {
                    main.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.hide();
                            }
                            let _ = app_handle.set_activation_policy(
                                tauri::ActivationPolicy::Accessory,
                            );
                        }
                    });
                }
            }

            // Global hotkey ⌥⌘⇧P → opens the main window at /prmaster.
            // The hotkey *handler* lives inside the plugin builder
            // (`build_global_shortcut_plugin`); here we just register the
            // chord. Failure is non-fatal — the user can still navigate
            // manually.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let chord = Shortcut::new(
                    Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
                    Code::KeyP,
                );
                if let Err(e) = app.global_shortcut().register(chord) {
                    tracing::warn!(?e, "global-shortcut register failed; hotkey disabled");
                }
            }

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
            commands::process_monitor::pm_popover_close,
            commands::process_monitor::pm_show_main_window,
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
            commands::markdown::markdown_move,
            commands::markdown::markdown_delete_to_trash,
            commands::markdown::markdown_search_contents,
            commands::markdown::markdown_search_files,
            commands::markdown::markdown_stop_content_search,
            commands::markdown::markdown_copy_svg_as_png,
            commands::markdown::markdown_write_bytes,
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
            commands::database::db_explain_query,
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
            // prmaster (P1 surface — Mine tab + auth + call log)
            commands::prmaster::prmaster_whoami,
            commands::prmaster::prmaster_get_gh_status,
            commands::prmaster::prmaster_get_mine,
            commands::prmaster::prmaster_get_to_review,
            commands::prmaster::prmaster_get_reviewed,
            commands::prmaster::prmaster_get_conversations,
            commands::prmaster::prmaster_approve_pr,
            commands::prmaster::prmaster_request_changes,
            commands::prmaster::prmaster_add_self_reviewer,
            commands::prmaster::prmaster_get_call_log,
            commands::prmaster::prmaster_hide_popover,
            commands::prmaster::prmaster_set_badge,
            commands::prmaster::prmaster_open_full_window,
            commands::prmaster::prmaster_get_settings,
            commands::prmaster::prmaster_save_settings,
            commands::prmaster::prmaster_list_filters,
            commands::prmaster::prmaster_save_filter,
            commands::prmaster::prmaster_delete_filter,
            commands::prmaster::prmaster_test_filter_notification,
            commands::prmaster::prmaster_refresh,
            commands::prmaster::prmaster_quit_app,
            commands::prmaster::prmaster_ai_summary,
            commands::prmaster::prmaster_ai_list_models,
            commands::prmaster::prmaster_clear_ai_cache,
            commands::prmaster::prmaster_load_ai_summaries,
            commands::prmaster::prmaster_save_ai_summaries,
            commands::prmaster::prmaster_clear_ai_summaries,
            commands::prmaster::prmaster_load_pr_snapshot,
            commands::prmaster::prmaster_get_ai_runs,
            commands::prmaster::prmaster_list_repos,
            commands::prmaster::prmaster_fetch_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
