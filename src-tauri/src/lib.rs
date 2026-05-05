//! Tauri application library entrypoint.
//!
//! Composes the workspace crates (`zen-types`, `zen-parser`, `zen-http`,
//! `zen-perf`) and exposes them to the React front-end via Tauri commands.

#![warn(missing_docs)]

pub mod commands;
pub mod data_dir_migration;
pub mod dictation;
pub mod dto;
pub mod error;
pub mod prmaster_lifecycle;
pub mod prmaster_tray;
pub mod schema_cache;
pub mod state;
pub mod tray;
pub mod user_config;

use commands::markdown_index::MarkdownIndexRegistry;
use commands::runs::{load_runs, RunHistory};
use state::AppState;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

/// Build the `tauri-plugin-global-shortcut` plugin with the always-on
/// hotkey handlers baked in. Two chords are wired up here:
///
///   * **⌥⌘⇧P** — focus the main window at `/prmaster`. Registered/
///     unregistered live by `prmaster_lifecycle` in step with the
///     PRMaster tool's enabled flag.
///   * **⌥⌘⇧T** — focus the main window at `/terminal`. Registered
///     unconditionally in `setup` (no background machinery to gate on);
///     the `DisabledGuard` on the terminal route handles the case where
///     the user has the tool disabled by redirecting back out.
///
/// Both handlers emit the same `prmaster:focus-route` event the React
/// `FocusRouteListener` already consumes — the payload (`/prmaster` or
/// `/terminal`) tells it where to navigate. The event name is now a
/// misnomer-of-history; the listener treats it as a generic
/// "navigate-to-route" channel.
fn build_global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
    let prmaster_chord = Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        Code::KeyP,
    );
    let terminal_chord = Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        Code::KeyT,
    );
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, sc, ev| {
            if ev.state() != ShortcutState::Pressed {
                return;
            }
            let route: Option<&'static str> = if sc == &prmaster_chord {
                Some("/prmaster")
            } else if sc == &terminal_chord {
                Some("/terminal")
            } else {
                None
            };
            let Some(route) = route else { return };
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
                let _ = app.emit("prmaster:focus-route", route);
            });
        })
        .build()
}

/// The terminal `/terminal` global hotkey (⌥⌘⇧T). Mirrors the chord
/// constructed inside `build_global_shortcut_plugin` — single source of
/// truth so we don't drift between the handler match and the registration
/// call below.
#[cfg(desktop)]
fn terminal_chord() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        Code::KeyT,
    )
}

/// Initialise the Tauri app. Called from `main.rs` and from mobile entry
/// points.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging is initialised inside `setup()` once we can resolve the
    // app-data dir for the rolling file appender. We deliberately do
    // NOT call `tracing_subscriber::fmt().try_init()` here at the top
    // of `run()` — doing so installs a global subscriber, and a
    // second `try_init` from `setup()` (where we add the file layer)
    // is then a silent no-op, which is exactly the bug that left the
    // logs file at zero bytes between commits 7a2b063 and 8d2e858.
    //
    // The cost: any `tracing::*` macro fired during plugin
    // construction (i.e. before `setup()` runs) is dropped on the
    // floor. Tauri's plugin registration is fast and uses `eprintln!`
    // for genuine errors anyway, so the trade is worth it.

    let mut builder = tauri::Builder::default();

    // ── Native terminal tab (macOS-only) ─────────────────────────
    // tauri-plugin-ghostty embeds libghostty as a CAMetalLayer-backed
    // NSView living *below* the WKWebView. The plugin owns the PTY,
    // surface, tab list, and chrome-inset feedback. Registered before
    // the rest of the chain so its commands are available the instant
    // the React `/terminal` route mounts.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_ghostty::init());
    }

    builder
        // Default macOS Tao behaviour for `CloseRequested` on a
        // non-main window is `[NSWindow orderOut:]` — the WKWebView is
        // hidden but its `WebContent` subprocess stays resident,
        // permanently leaking memory once the user has summoned a
        // popover for the first time. Mirror flowstate's recipe:
        // `prevent_close()` (mandatory — must come BEFORE destroy or
        // the default hide races us) followed by `destroy()` so the
        // WKWebView and its subprocess are actually freed.
        // The main window stays on the existing
        // hide-window + Accessory-activation path (registered below in
        // `setup`) so closing it keeps the background agent alive.
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    api.prevent_close();
                    if let Err(e) = window.destroy() {
                        tracing::warn!(
                            label = %window.label(),
                            error = %e,
                            "non-main window destroy failed",
                        );
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
            }
        })
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
            // ── Logging ────────────────────────────────────────────────
            // One Registry, two layers: a coloured stdout layer and a
            // daily-rotating file layer at <app_data_dir>/logs/zen-tools.log.
            // Both share the same EnvFilter (RUST_LOG override → fall
            // back to "info,zen=debug").
            //
            // Installed exactly once via `init()`. The previous shape
            // — two separate `tracing_subscriber::fmt().try_init()`
            // calls, one early and one in setup — silently dropped
            // the second registration because tracing's global default
            // is first-installed-wins. That's why the on-disk log
            // file was empty until this commit.
            //
            // The non-blocking worker guard from `tracing-appender`
            // is `Box::leak`'d so it lives the lifetime of the
            // process; without that the background writer tears down
            // and log lines emitted just before exit are lost.
            let env_filter = EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,zen=debug"));
            let stdout_layer = fmt::layer().with_target(false);
            let file_layer = match dictation::logs_dir(app.handle()) {
                Ok(dir) => {
                    let appender = tracing_appender::rolling::daily(&dir, "zen-tools.log");
                    let (writer, guard) = tracing_appender::non_blocking(appender);
                    Box::leak(Box::new(guard));
                    Some(
                        fmt::layer()
                            .with_target(false)
                            .with_ansi(false)
                            .with_writer(writer)
                            .boxed(),
                    )
                }
                Err(e) => {
                    eprintln!("zen-tools: file logging disabled — {e}");
                    None
                }
            };
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stdout_layer)
                .with(file_layer)
                .init();
            tracing::info!("zen-tools: logging initialised");

            // ── Bundle-id rename migration ────────────────────────────
            // Old builds wrote to `~/Library/Application Support/
            // com.zen-tools.app/`; the bundle id is now
            // `com.seg4lt.zen-tools` so Tauri's `app_data_dir()`
            // resolves to a different sibling under the same parent.
            // This step copies the old dir into the new one ONCE, so
            // existing users keep their PRMaster filters / dictation
            // settings / run history / schema cache across the rename.
            //
            // Idempotent — short-circuits when the new dir already
            // contains a settled marker (user_config.db /
            // preferences.json). Safe to leave in place across
            // versions; remove a few releases after the rename ships.
            //
            // Runs BEFORE `user_config::open` because that call
            // creates `user_config.db` in the new dir, which would
            // trip the migration's "already settled" guard on the
            // very same boot.
            data_dir_migration::migrate_legacy_app_data_dir(app.handle());

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

            // ── Unified menu-bar tray ─────────────────────────────────
            // One tray for the whole app — see `crate::tray`. Built
            // once here, lives the lifetime of the process. The menu
            // adapts to current state (perf running, PM active,
            // PRMaster enabled, dictation enabled) via fire-and-forget
            // `tray::update` calls from each tool's command paths.
            if let Err(e) = tray::init(app.handle()) {
                tracing::warn!(?e, "tray::init failed; menu-bar will not be available");
            }

            // ── PRMaster: broadcast bridge + 5-min poll + global hotkey,
            // but only if the user hasn't disabled the app from the
            // settings list. Disabled tools should be completely silent
            // — no background gh calls, no chord registration. Toggling
            // back on at runtime is wired through the
            // `set_tool_disabled` command, which calls
            // `prmaster_lifecycle::start` to re-arm everything.
            let prmaster_disabled = commands::preferences::load_preferences(app.handle())
                .map(|p| p.disabled_tools.iter().any(|id| id == "prmaster"))
                .unwrap_or(false);
            if !prmaster_disabled {
                prmaster_lifecycle::start(app.handle());
            } else {
                tracing::info!("PRMaster disabled in preferences; skipping poll/hotkey");
            }

            // ── Terminal global hotkey (⌥⌘⇧T) ────────────────────────
            // Unlike PRMaster's chord, the terminal hotkey has no
            // background machinery to gate on, so it's registered
            // unconditionally for the lifetime of the process. If the
            // user has the terminal tool disabled in preferences the
            // route's `DisabledGuard` redirects them out — the chord
            // still works as a "summon zen-tools" hotkey, just lands
            // them on the first enabled tool instead.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(terminal_chord()) {
                    tracing::warn!(?e, "terminal global-shortcut register failed; ⌥⌘⇧T disabled");
                }
            }

            // Background-agent lifecycle: closing the main window
            // never exits the app. The unified menu-bar tray (see
            // `crate::tray`) is permanent for the lifetime of the
            // process and provides "Show Zen Tools" and "Quit" so
            // the user always has a way back in / a way to exit.
            // Closing → hide window + flip to Accessory (no Dock
            // icon). The only exit path is the tray's "Quit Zen
            // Tools" menu item.
            //
            // Re-opening from the hidden state happens via the tray
            // menu's "Show Zen Tools" item, the PRMaster hotkey, the
            // `prmaster_open_full_window` command, the
            // `RunEvent::Reopen` handler below (Dock-icon click), or
            // the right-⌘ tap-then-hold dictation gesture.
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

            // ── Dictation ─────────────────────────────────────────────
            // Resolve the per-app data dirs and register the managed
            // state, then hand off to `dictation::bootstrap`. That:
            //
            //   * Hydrates the persisted selected-model id.
            //   * Reads `Preferences::disabled_tools`; if "dictation"
            //     is in the list, it stops here.
            //   * Otherwise calls `dictation::lifecycle::start` to
            //     install the CGEventTap and kick off the base-model
            //     download.
            //
            // The Settings UI's enable switch routes through
            // `set_tool_disabled("dictation", _)` which calls into
            // the same lifecycle module to flip start/stop live.
            let app_data_dir = app.path().app_data_dir().ok();
            let models_dir_path = dictation::models_dir(app.handle()).ok();
            let logs_dir_path = dictation::logs_dir(app.handle()).ok();
            if let (Some(app_data), Some(models), Some(logs)) =
                (app_data_dir, models_dir_path, logs_dir_path)
            {
                let dictation_state =
                    dictation::state::DictationTauriState::new(app_data, models, logs);
                app.manage(dictation_state);
                dictation::bootstrap(app.handle());
            } else {
                tracing::warn!("dictation: failed to resolve app_data_dir; feature disabled");
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
            commands::preferences::set_tool_disabled,
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
            commands::database::db_cancel_query,
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
            commands::prmaster::prmaster_list_review_comments,
            commands::prmaster::prmaster_resolve_review_thread,
            commands::prmaster::prmaster_approve_pr,
            commands::prmaster::prmaster_request_changes,
            commands::prmaster::prmaster_add_self_reviewer,
            commands::prmaster::prmaster_get_pr_diff,
            commands::prmaster::prmaster_add_review_comment,
            commands::prmaster::prmaster_reply_review_comment,
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
            // dictation (local Whisper)
            dictation::commands::dictation_is_supported,
            dictation::commands::dictation_list_models,
            dictation::commands::dictation_get_state,
            dictation::commands::dictation_select_model,
            dictation::commands::dictation_download_model,
            dictation::commands::dictation_open_app_data_dir,
            dictation::commands::dictation_open_logs_dir,
            dictation::commands::dictation_open_models_dir,
            dictation::commands::dictation_get_paths,
            // Permissions UX — recovers users who got stuck after a
            // bundle-id rename / unsigned-reinstall left a stale TCC
            // entry that won't re-prompt. See
            // `crate::dictation::permissions` for the rationale.
            dictation::commands::dictation_get_permissions,
            dictation::commands::dictation_reset_accessibility,
            dictation::commands::dictation_reset_microphone,
            dictation::commands::dictation_open_privacy_pane,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS Dock-icon click after the user closed the main
            // window. Without this handler the click is a no-op:
            // CloseRequested hid the window and dropped the Dock
            // icon's activation to `Accessory`, so AppKit doesn't
            // pick the click up as "open the main window again". We
            // restore `Regular` policy + show + focus the main
            // window, then ask the frontend to navigate to the
            // user's first enabled tool — the route persisted on the
            // window before close was usually `/settings` (the user
            // tweaks settings then closes), and greeting them with
            // Settings on every reopen feels wrong. The
            // `FirstToolListener` in `src/router.tsx` consumes the
            // `app:focus-first-tool` event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("app:focus-first-tool", ());
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}
