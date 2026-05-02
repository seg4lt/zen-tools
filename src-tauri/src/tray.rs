//! macOS menu-bar (system tray) icon manager.
//!
//! Zen Tools is a normal app with a Dock icon — the tray is **only**
//! present while there is something interesting to look at. Specifically,
//! [`update_tray`] creates the tray when either:
//!
//!   - a HTTP Runner perf test is in flight (`AppState.perf_running`), or
//!   - the Process Monitor has at least one root PID configured
//!
//! …and removes it the instant both conditions go false. The menu adapts
//! to whichever activity is currently running (so a perf-only run sees
//! "Stop Perf Test" but no "Stop Monitoring", and vice-versa).
//!
//! ## Why everything is "fire-and-forget"
//!
//! [`update_tray`] is called from:
//!   - async Tauri commands (already on a tokio worker)
//!   - tokio tasks spawned inside the perf runner (also a tokio worker)
//!   - the tray menu / click event handlers (Wry main thread)
//!
//! The `AppState` lives behind a [`tokio::sync::Mutex`], whose
//! `blocking_lock()` **panics** when called from a tokio runtime thread.
//! To get a single API that works from every caller, we always spawn the
//! reconcile work onto `tauri::async_runtime` and use the async
//! `lock().await`. Eventual consistency is fine here — the tray just needs
//! to settle into the correct state shortly after each mutation.
//!
//! Concurrent reconcile calls are serialised by holding the `AppState`
//! lock across the whole reconcile (a few ms at most): without this two
//! near-simultaneous events could each see "tray missing" and build
//! duplicate status items.

use crate::state::AppState;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, Size,
};
use tokio::sync::Mutex;

/// Stable id used by [`AppHandle::remove_tray_by_id`].
const TRAY_ID: &str = "zen-tools";

/// Window label of the small popover spawned by left-clicking the tray.
/// Declared in `tauri.conf.json` (hidden by default) so we can just
/// reposition + show it on demand without going through `WebviewWindowBuilder`.
const POPOVER_LABEL: &str = "pm-popover";

/// Embedded template PNG (auto-inverts for light/dark menu bars).
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");

/// Reconcile the tray icon with current activity. Idempotent — safe to
/// call from any command after a state mutation. Spawns the actual work
/// onto the Tauri async runtime so the caller never blocks (and so we
/// never invoke `blocking_lock()` on a tokio worker).
pub fn update_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = update_tray_inner(&app).await {
            tracing::warn!("update_tray failed: {e}");
        }
    });
}

async fn update_tray_inner(app: &AppHandle) -> tauri::Result<()> {
    // Hold the AppState lock for the whole reconcile so two concurrent
    // calls can't both see `tray.is_none()` and build duplicate status
    // items. Tray construction is a few ms at most; other commands
    // briefly queue.
    let state_arc = app.state::<Mutex<AppState>>();
    let mut s = state_arc.lock().await;

    let perf_running = s.perf_running;
    let pm_active = s.pm_is_active();
    let should_show = perf_running || pm_active;
    let already_shown = s.tray.is_some();

    match (should_show, already_shown) {
        (true, true) => {
            // Rebuild menu so "Stop X" items reflect current state.
            let menu = build_menu(app, perf_running, pm_active)?;
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                tray.set_menu(Some(menu))?;
            }
        }
        (true, false) => {
            let tray = build_tray(app, perf_running, pm_active)?;
            s.tray = Some(tray);
        }
        (false, true) => {
            // ⚠️ Drop the TrayIcon on the main thread.
            //
            // On macOS the underlying `NSStatusItem` lives on the main
            // (Cocoa) thread; releasing it from a tokio worker thread
            // causes a hard crash inside AppKit. `take()` here moves
            // ownership out of `AppState` so we can ferry it to the
            // main thread for disposal — `remove_tray_by_id` then
            // wipes the manager's clone so no stray reference remains.
            let to_drop = s.tray.take();
            if let Some(tray) = to_drop {
                let app_clone = app.clone();
                let _ = app.run_on_main_thread(move || {
                    drop(tray);
                    let _ = app_clone.remove_tray_by_id(TRAY_ID);
                });
            }
        }
        (false, false) => {}
    }
    Ok(())
}

fn build_menu(
    app: &AppHandle,
    perf_running: bool,
    pm_active: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show Zen Tools", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let stop_perf =
        MenuItem::with_id(app, "stop_perf", "Stop Perf Test", perf_running, None::<&str>)?;
    let stop_pm = MenuItem::with_id(app, "stop_pm", "Stop Monitoring", pm_active, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Zen Tools", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &sep1, &stop_perf, &stop_pm, &sep2, &quit])
}

fn build_tray(
    app: &AppHandle,
    perf_running: bool,
    pm_active: bool,
) -> tauri::Result<tauri::tray::TrayIcon> {
    let menu = build_menu(app, perf_running, pm_active)?;
    let icon = Image::from_bytes(TRAY_ICON_PNG)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        // Left-click brings the main window forward; right-click shows the
        // menu (the default behaviour when the left-click handler doesn't
        // claim the event).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => focus_main_window(app),
            "stop_perf" => stop_perf_test(app),
            "stop_pm" => clear_pm_targets(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                rect,
                ..
            } = event
            {
                use tauri::tray::{MouseButton, MouseButtonState};
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    toggle_popover(tray.app_handle(), rect.position, rect.size);
                }
            }
        })
        .build(app)
}

/// Show or hide the mini popover window. Positioned just below the tray
/// icon so it reads as an attached panel rather than a free-floating
/// window. If the popover is already visible, a second click hides it.
fn toggle_popover(app: &AppHandle, tray_pos: Position, tray_size: Size) {
    let Some(win) = app.get_webview_window(POPOVER_LABEL) else {
        tracing::warn!("popover window '{}' not found", POPOVER_LABEL);
        return;
    };

    // If already visible, treat the click as a "dismiss" gesture so the
    // tray feels like a togglable status item.
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }

    // Normalise the tray rect into physical pixels regardless of
    // which Position/Size variant the platform returns; window
    // metrics from `outer_size()` are also physical.
    let scale = win.scale_factor().unwrap_or(1.0);
    let icon_phys = match tray_pos {
        Position::Physical(p) => PhysicalPosition::new(p.x as f64, p.y as f64),
        Position::Logical(p) => PhysicalPosition::new(p.x * scale, p.y * scale),
    };
    let icon_size_phys = match tray_size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width * scale, s.height * scale),
    };

    let win_w = win.outer_size().map(|s| s.width as f64).unwrap_or(340.0);
    let icon_centre_x = icon_phys.x + icon_size_phys.0 / 2.0;
    let target_x = icon_centre_x - win_w / 2.0;
    let target_y = icon_phys.y + icon_size_phys.1 + 4.0;

    let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
    let _ = win.show();
    let _ = win.set_focus();
}

/// Hide the popover (called from the popover's "Open Full Window" button
/// via the `pm_popover_close` command).
pub fn hide_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(POPOVER_LABEL) {
        let _ = win.hide();
    }
}

/// Bring the main webview window forward, unminimising and focusing it.
fn focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Cancel the in-flight perf test by signalling the stop handle. The perf
/// completion task will call [`update_tray`] when the runner unwinds.
fn stop_perf_test(app: &AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_clone.state::<Mutex<AppState>>();
        let s = state.lock().await;
        if let Some(handle) = &s.perf_stop {
            handle.stop();
        }
    });
}

/// Clear the Process Monitor target list. Asynchronous because we need
/// the tokio mutex; the tray will reconcile when [`update_tray`] runs.
/// Also emits `pm:targets-cleared` so the React store picks up the
/// change made via the tray menu (no IPC round-trip needed).
fn clear_pm_targets(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        {
            let state = app.state::<Mutex<AppState>>();
            let s = state.lock().await;
            s.pm_state.lock().clear_targets();
        }
        let _ = app.emit("pm:targets-cleared", ());
        update_tray(&app);
    });
}
