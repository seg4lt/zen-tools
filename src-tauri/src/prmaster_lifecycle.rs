//! Start / stop the always-on PRMaster background machinery.
//!
//! PRMaster owns four pieces of always-on plumbing in the Tauri layer:
//!
//! 1. The permanent menu-bar **tray icon** (frameless 500×700 popover
//!    behind a left-click).
//! 2. A **broadcast → Tauri-event bridge** that re-emits engine events
//!    (`Refreshed`, `BadgeChanged`, `Notification`) to the front-end
//!    and dispatches notifications through the macOS notification
//!    centre.
//! 3. A **5-minute background refresh loop** that polls GitHub via the
//!    `gh` CLI and feeds the engine.
//! 4. A **global hotkey** (⌥⌘⇧P) that focuses the main window at
//!    `/prmaster`.
//!
//! All four must light up only when the user has the PRMaster tool
//! enabled. This module exposes [`start`] and [`stop`] so the startup
//! flow in `lib.rs` and the live `set_tool_disabled` command can flip
//! the whole bundle atomically.
//!
//! Idempotent — calling [`start`] when PRMaster is already running, or
//! [`stop`] when it's already off, is a no-op.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use zen_prmaster::PrMasterEvent;

use crate::commands;
use crate::prmaster_tray;
use crate::state::AppState;
use crate::user_config::UserConfig;

/// The chord registered as PRMaster's global hotkey. Mirrors the
/// `Shortcut` constructed inside `build_global_shortcut_plugin` —
/// keeping a single source of truth here lets us toggle registration
/// without duplicating the chord description.
#[cfg(desktop)]
fn prmaster_chord() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(
        Some(Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER),
        Code::KeyP,
    )
}

/// Spin up every PRMaster background worker. Idempotent.
///
/// Records the spawned tasks' [`AbortHandle`]s on
/// [`crate::state::PrMasterLifecycle`] so [`stop`] can cancel them.
pub fn start(app: &AppHandle) {
    // Skip if already running. The tray's presence is the canonical
    // signal — bridge/bg_task are restarted alongside it.
    if app.tray_by_id(prmaster_tray::PRMASTER_TRAY_ID).is_some() {
        return;
    }

    // 1) Tray.
    if let Err(e) = prmaster_tray::init(app) {
        tracing::warn!(?e, "prmaster_tray::init failed");
    }

    // 2) Broadcast → Tauri-event bridge.
    let prmaster_engine = {
        let app_state = app.state::<Mutex<AppState>>();
        let s = app_state.blocking_lock();
        s.prmaster.clone()
    };
    let mut prmaster_rx = prmaster_engine.subscribe();
    let bridge_app = app.clone();
    let bridge_task = tauri::async_runtime::spawn(async move {
        use tauri_plugin_notification::NotificationExt;
        loop {
            match prmaster_rx.recv().await {
                Ok(PrMasterEvent::Refreshed(snapshot)) => {
                    let _ = bridge_app.emit("prmaster:refreshed", &snapshot);
                    // Persist the latest snapshot so the next cold
                    // start hydrates from disk instead of showing an
                    // empty list until the first poll completes.
                    let cfg = bridge_app.state::<UserConfig>();
                    commands::prmaster::persist_pr_snapshot(cfg.inner(), &snapshot);
                }
                Ok(PrMasterEvent::BadgeChanged(text)) => {
                    prmaster_tray::set_badge(&bridge_app, &text);
                    let _ = bridge_app.emit("prmaster:badge-changed", &text);
                }
                Ok(PrMasterEvent::Notification(note)) => {
                    let _ = bridge_app.emit("prmaster:notification", &note);
                    if note.badge_only || note.muted {
                        continue;
                    }
                    let mut builder = bridge_app
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

    // 3) 5-minute background refresh + immediate first refresh so the
    //    badge populates as soon as gh data lands.
    let bg_engine = prmaster_engine.clone();
    let bg_app = app.clone();
    let bg_task = tauri::async_runtime::spawn(async move {
        let initial_settings = {
            let cfg = bg_app.state::<UserConfig>();
            cfg.get::<zen_prmaster::PrMasterSettings>("prmaster")
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        if let Err(e) = bg_engine.refresh_lists_and_notify(&initial_settings).await {
            tracing::warn!(error = %e, "initial refresh failed");
        }

        let mut tick = tokio::time::interval(Duration::from_secs(300));
        tick.tick().await; // skip immediate first tick
        loop {
            tick.tick().await;
            let settings = {
                let cfg = bg_app.state::<UserConfig>();
                cfg.get::<zen_prmaster::PrMasterSettings>("prmaster")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
            };
            if let Err(e) = bg_engine.refresh_lists_and_notify(&settings).await {
                tracing::warn!(error = %e, "background refresh failed");
            }
        }
    });

    // 4) Global hotkey.
    #[cfg(desktop)]
    let hotkey_registered = {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        match app.global_shortcut().register(prmaster_chord()) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(?e, "global-shortcut register failed; hotkey disabled");
                false
            }
        }
    };
    #[cfg(not(desktop))]
    let hotkey_registered = false;

    // 5) Persist join handles so `stop` can abort them.
    let app_state = app.state::<Mutex<AppState>>();
    let mut s = app_state.blocking_lock();
    s.prmaster_lifecycle.bridge_task = Some(bridge_task);
    s.prmaster_lifecycle.bg_task = Some(bg_task);
    s.prmaster_lifecycle.hotkey_registered = hotkey_registered;
}

/// Tear down every PRMaster background worker. Idempotent.
///
/// After this returns the tray is gone, both background tasks are
/// aborting (they may still be flushing a final iteration), and the
/// global hotkey no longer fires.
pub fn stop(app: &AppHandle) {
    // 1) Abort both background tasks.
    {
        let app_state = app.state::<Mutex<AppState>>();
        let mut s = app_state.blocking_lock();
        if let Some(handle) = s.prmaster_lifecycle.bridge_task.take() {
            handle.abort();
        }
        if let Some(handle) = s.prmaster_lifecycle.bg_task.take() {
            handle.abort();
        }
    }

    // 2) Unregister the hotkey so the chord stops triggering.
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let registered = {
            let app_state = app.state::<Mutex<AppState>>();
            let mut s = app_state.blocking_lock();
            let was = s.prmaster_lifecycle.hotkey_registered;
            s.prmaster_lifecycle.hotkey_registered = false;
            was
        };
        if registered {
            if let Err(e) = app.global_shortcut().unregister(prmaster_chord()) {
                tracing::warn!(?e, "global-shortcut unregister failed");
            }
        }
    }

    // 3) Drop the tray icon and hide the popover. Last so any final
    //    badge updates from in-flight broadcast events have already
    //    been suppressed by the bridge abort above.
    prmaster_tray::tear_down(app);
}
