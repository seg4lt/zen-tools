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

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use zen_prmaster::PrMasterEvent;

use crate::commands;
use crate::prmaster_tray;
use crate::state::AppState;
use crate::user_config::UserConfig;

#[derive(Clone, serde::Serialize)]
/// Buffered notification activation awaiting frontend acknowledgement.
pub struct PendingFocusRoute {
    /// Monotonic identifier used to reject stale activation races.
    pub generation: u64,
    /// Internal application route for the activated notification.
    pub route: String,
}

static NEXT_FOCUS_ROUTE_GENERATION: AtomicU64 = AtomicU64::new(1);
static PENDING_FOCUS_ROUTE: std::sync::Mutex<Option<PendingFocusRoute>> =
    std::sync::Mutex::new(None);

fn pending_focus_route() -> std::sync::MutexGuard<'static, Option<PendingFocusRoute>> {
    PENDING_FOCUS_ROUTE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Read the most recent notification route without clearing it.
pub(crate) fn peek_pending_focus_route() -> Option<PendingFocusRoute> {
    pending_focus_route().clone()
}

/// Clear a delivered activation without erasing a newer generation.
pub(crate) fn acknowledge_pending_focus_route(generation: u64) {
    let mut pending = pending_focus_route();
    if pending.as_ref().map(|activation| activation.generation) == Some(generation) {
        pending.take();
    }
}

fn notification_response_opens(response: &notify_rust::NotificationResponse) -> bool {
    match response {
        notify_rust::NotificationResponse::Default => true,
        notify_rust::NotificationResponse::Action(action) => action == "default",
        _ => false,
    }
}

fn focus_main_window_at_route(app: &AppHandle, route: String) {
    let activation = PendingFocusRoute {
        generation: NEXT_FOCUS_ROUTE_GENERATION.fetch_add(1, Ordering::Relaxed),
        route,
    };
    *pending_focus_route() = Some(activation.clone());
    crate::show_or_create_main_window(app);
    if let Err(error) = app.emit_to(
        tauri::EventTarget::any(),
        "prmaster:focus-route-activation",
        activation,
    ) {
        tracing::warn!(%error, "notification route emit failed");
    }
}

/// Present a native PRMaster notification and retain its response handle.
///
/// `tauri-plugin-notification` intentionally drops the desktop handle after
/// showing a banner, which makes the notification display-only. Keeping the
/// notify-rust handle alive lets us distinguish a click from a dismissal and
/// route the main window to the PR that produced the banner.
fn show_pr_notification(app: &AppHandle, note: zen_prmaster::PendingNotification) {
    let app = app.clone();
    let spawn_result = std::thread::Builder::new()
        .name("prmaster-notification-response".into())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            {
                let bundle_id = if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    app.config().identifier.as_str()
                };
                // mac-notification-sys permits setting the application only once.
                // A repeated call is harmless and simply returns an error.
                let _ = notify_rust::set_application(bundle_id);
            }

            let mut notification = notify_rust::Notification::new();
            notification
                .summary(&note.title)
                .body(&note.body)
                .action("default", "Open PR");
            #[cfg(windows)]
            notification.app_id(&app.config().identifier);
            if note.silent {
                notification.sound_name("");
            }

            let handle = match notification.show() {
                Ok(handle) => handle,
                Err(error) => {
                    tracing::warn!(%error, "notification show failed");
                    return;
                }
            };

            let route = note.route;
            if let Err(error) =
                handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                    if notification_response_opens(response) {
                        focus_main_window_at_route(&app, route);
                    }
                })
            {
                tracing::warn!(%error, "notification response wait failed");
            }
        });
    if let Err(error) = spawn_result {
        tracing::warn!(%error, "notification response thread spawn failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_rust::{CloseReason, NotificationResponse};

    #[test]
    fn opens_for_body_and_named_default_action_only() {
        assert!(notification_response_opens(&NotificationResponse::Default));
        assert!(notification_response_opens(&NotificationResponse::Action(
            "default".into()
        )));
        assert!(!notification_response_opens(&NotificationResponse::Action(
            "other".into()
        )));
        assert!(!notification_response_opens(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
    }

    #[test]
    fn acknowledgement_does_not_erase_a_newer_route() {
        *pending_focus_route() = Some(PendingFocusRoute {
            generation: 2,
            route: "/prmaster/detail/new/repo/2".into(),
        });
        acknowledge_pending_focus_route(1);
        let pending = peek_pending_focus_route().expect("newer route should remain pending");
        assert_eq!(pending.generation, 2);
        assert_eq!(pending.route, "/prmaster/detail/new/repo/2");
        acknowledge_pending_focus_route(2);
        assert!(peek_pending_focus_route().is_none());
    }
}

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

    // 1) Build PRMaster's permanent menu-bar tray. AppKit's
    //    `NSStatusItem` is main-thread-only, so we hop to the
    //    Cocoa main thread before constructing it. Idempotent —
    //    `init` no-ops if the tray is already present.
    if app.tray_by_id(prmaster_tray::PRMASTER_TRAY_ID).is_none() {
        let tray_app = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            if let Err(e) = prmaster_tray::init(&tray_app) {
                tracing::warn!(?e, "prmaster_tray::init failed");
            }
        }) {
            tracing::warn!(?e, "run_on_main_thread for tray init failed");
        }
    }

    // 2) Broadcast → Tauri-event bridge.
    let prmaster_engine = {
        let app_state = app.state::<Mutex<AppState>>();
        let s = app_state.lock().await;
        s.prmaster.clone()
    };
    let mut prmaster_rx = prmaster_engine.subscribe();
    let bridge_app = app.clone();
    let bridge_task = tauri::async_runtime::spawn(async move {
        loop {
            match prmaster_rx.recv().await {
                Ok(PrMasterEvent::Refreshed(snapshot)) => {
                    let _ = bridge_app.emit("prmaster:refreshed", &snapshot);
                    let cfg = bridge_app.state::<UserConfig>();
                    commands::prmaster::persist_pr_snapshot(cfg.inner(), &snapshot);
                    commands::pr_review::schedule_closed_pr_cleanup(&bridge_app, &snapshot);
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
                    show_pr_notification(&bridge_app, note);
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
        let initial_low_priority = {
            let cfg = bg_app.state::<UserConfig>();
            commands::prmaster::load_low_priority_pr_ids(cfg.inner()).unwrap_or_default()
        };
        if let Err(e) = bg_engine
            .refresh_lists_and_notify(&initial_settings, &initial_low_priority)
            .await
        {
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
            let low_priority_pr_ids = {
                let cfg = bg_app.state::<UserConfig>();
                commands::prmaster::load_low_priority_pr_ids(cfg.inner()).unwrap_or_default()
            };
            if let Err(e) = bg_engine
                .refresh_lists_and_notify(&settings, &low_priority_pr_ids)
                .await
            {
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

    // 3) Tear down PRMaster's tray entirely (icon + popover).
    //    `tear_down` releases the `NSStatusItem` and destroys the
    //    popover's `NSWindow`; both touch AppKit so we hop to the
    //    Cocoa main thread or it crashes hard. Bridge-abort above
    //    already suppressed any in-flight badge updates.
    let teardown_app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        prmaster_tray::tear_down(&teardown_app);
    }) {
        tracing::warn!(?e, "run_on_main_thread for tray tear_down failed");
    }
}
