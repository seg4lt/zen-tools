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
//! ## Threading
//!
//! Both [`start`] and [`stop`] are **fire-and-forget** — they spawn
//! the actual work onto the Tauri async runtime so the caller never
//! blocks and we never call `tokio::sync::Mutex::blocking_lock()`
//! from a tokio worker (which panics → SIGABRT). This mirrors
//! `crate::tray::update`'s pattern. Eventual consistency is fine
//! here: the lifecycle just needs to settle into the requested state
//! shortly after the call.
//!
//! AppKit-touching steps (tray construction, tray drop, popover
//! destruction) are dispatched onto the main thread via
//! `AppHandle::run_on_main_thread` because `NSStatusItem` /
//! `NSWindow` will hard-crash if released or mutated from a
//! non-Cocoa thread.
//!
//! Idempotent — calling [`start`] when PRMaster is already running, or
//! [`stop`] when it's already off, is a no-op.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use zen_prmaster::PrMasterEvent;

use crate::commands;
use crate::state::AppState;
use crate::tray;
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
/// Fire-and-forget — see the module docs for the threading rationale.
/// Safe to call from `setup` (sync, AppKit main thread) and from any
/// async Tauri command running on a tokio worker.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        start_inner(&app).await;
    });
}

async fn start_inner(app: &AppHandle) {
    // Skip if already running. The bridge-task slot in AppState is
    // the canonical signal — broadcast bridge / bg poll / hotkey are
    // co-managed with it.
    {
        let app_state = app.state::<Mutex<AppState>>();
        let s = app_state.lock().await;
        if s.prmaster_lifecycle.bridge_task.is_some() {
            return;
        }
    }

    // 1) Repaint the unified tray so PRMaster's "Open PRMaster"
    //    item flips from disabled to enabled.
    tray::update(app);

    // 2) Broadcast → Tauri-event bridge.
    let prmaster_engine = {
        let app_state = app.state::<Mutex<AppState>>();
        let s = app_state.lock().await;
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
                    let cfg = bridge_app.state::<UserConfig>();
                    commands::prmaster::persist_pr_snapshot(cfg.inner(), &snapshot);
                }
                Ok(PrMasterEvent::BadgeChanged(text)) => {
                    tray::set_badge(&bridge_app, &text);
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
    let mut s = app_state.lock().await;
    s.prmaster_lifecycle.bridge_task = Some(bridge_task);
    s.prmaster_lifecycle.bg_task = Some(bg_task);
    s.prmaster_lifecycle.hotkey_registered = hotkey_registered;
}

/// Tear down every PRMaster background worker. Idempotent.
///
/// Fire-and-forget — see the module docs for the threading rationale.
pub fn stop(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        stop_inner(&app).await;
    });
}

async fn stop_inner(app: &AppHandle) {
    // 1) Abort both background tasks.
    {
        let app_state = app.state::<Mutex<AppState>>();
        let mut s = app_state.lock().await;
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
            let mut s = app_state.lock().await;
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

    // 3) Destroy the popover (touches AppKit `NSWindow`; release on
    //    the Cocoa main thread or it crashes hard) and clear any
    //    PR badge title left on the unified tray. Last so any final
    //    badge updates from in-flight broadcast events have already
    //    been suppressed by the bridge abort above.
    let teardown_app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        tray::destroy_prmaster_popover(&teardown_app);
        tray::set_badge(&teardown_app, "");
    }) {
        tracing::warn!(?e, "run_on_main_thread for tray teardown failed");
    }

    // 4) Repaint the tray so PRMaster's "Open PRMaster" item greys
    //    out. Fire-and-forget — `tray::update` hops to the runtime.
    tray::update(app);
}
