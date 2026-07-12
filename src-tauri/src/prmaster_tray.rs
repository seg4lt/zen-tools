//! Permanent macOS menu-bar tray for the **PRMaster** tool.
//!
//! Separate from [`crate::tray`] (the lazy zen-tools tray that comes and
//! goes with perf / process-monitor activity) — this one is created **once**
//! during `setup` and stays for the lifetime of the app, mirroring the
//! always-present `MenuBarExtra` in PRMaster.
//!
//! The badge follows PRMaster's actual UX: SF Symbol `arrow.triangle.pull`
//! (rendered here as the same template PNG used by the zen-tools tray) +
//! a text title via `TrayIcon::set_title`. macOS NSStatusItem natively
//! supports image+title side-by-side, which matches `MenuBarLabel`'s
//! SwiftUI `Label(...)` layout 1-to-1.
//!
//! Click handling:
//! * **Left-click** focuses the main PRMaster window at `/prmaster`.
//! * **Right-click** shows the same `Open PRMaster` / `Quit` menu.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::state::AppState;

/// Stable id for the PRMaster tray. Distinct from the zen-tools tray id
/// in [`crate::tray`] so they coexist.
pub const PRMASTER_TRAY_ID: &str = "prmaster";

/// Embedded template PNG. Renders the macOS SF Symbol
/// `arrow.triangle.pull` (the same glyph the Swift PRMaster app uses
/// for its menu-bar label) baked at 44×44 with `isTemplate = true` so
/// macOS auto-tints it to match the menu-bar appearance. Distinct from
/// the zen-tools app logo so the PRMaster tray reads as PR-specific at
/// a glance.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/pr-tray-icon.png");

/// Build the PRMaster tray on app startup. Idempotent — calling twice is
/// harmless; the second call no-ops because the tray is keyed by id.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(PRMASTER_TRAY_ID).is_some() {
        return Ok(());
    }

    let menu = build_menu(app)?;
    let icon = Image::from_bytes(TRAY_ICON_PNG)?;

    let tray = TrayIconBuilder::with_id(PRMASTER_TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("PRMaster")
        .menu(&menu)
        // Left-click is our primary interaction; right-click opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "prmaster_open_main" => focus_main_window_at_prmaster(app),
            "prmaster_quit" => crate::exit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    focus_main_window_at_prmaster(tray.app_handle());
                }
            }
        })
        .build(app)?;

    {
        let state_arc = app.state::<tokio::sync::Mutex<AppState>>();
        let mut s = state_arc.blocking_lock();
        s.prmaster_tray = Some(tray);
    }

    Ok(())
}

/// Remove the tray icon. Used when the user disables the PRMaster app
/// from the settings list — the tray vanishes immediately. Idempotent.
pub fn tear_down(app: &AppHandle) {
    if app.remove_tray_by_id(PRMASTER_TRAY_ID).is_none() {
        tracing::debug!("prmaster_tray::tear_down: no tray to remove");
    }
    // Clear the cached handle so a subsequent `init` builds a fresh tray.
    {
        let state_arc = app.state::<tokio::sync::Mutex<AppState>>();
        let mut s = state_arc.blocking_lock();
        s.prmaster_tray = None;
    }
}

/// Update the badge title shown next to the tray icon. Pass an empty string
/// to clear the badge.
pub fn set_badge(app: &AppHandle, badge: &str) {
    if let Some(tray) = app.tray_by_id(PRMASTER_TRAY_ID) {
        let title = if badge.is_empty() { None } else { Some(badge) };
        if let Err(e) = tray.set_title(title) {
            tracing::warn!(?e, "tray set_title failed");
        }
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open = MenuItem::with_id(
        app,
        "prmaster_open_main",
        "Open PRMaster",
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "prmaster_quit",
        "Quit PRMaster",
        true,
        Some("Cmd+Q"),
    )?;
    Menu::with_items(app, &[&open, &sep, &quit])
}

/// Focus the main window and navigate to the PRMaster route.
pub fn focus_main_window_at_prmaster(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    // Tell the frontend to navigate to /prmaster regardless of where the
    // user was. The router subscribes to this event in `App.tsx`.
    let _ = app.emit_to(
        tauri::EventTarget::any(),
        "prmaster:focus-route",
        "/prmaster",
    );

    // Restore the regular activation policy so the dock icon comes back
    // when we expand to the main window from a hidden / accessory state.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }
}

// `Emitter` is needed for `emit_to`. Imported at the top of `lib.rs`
// already; re-imported here so this module is self-contained.
use tauri::Emitter;
