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
//! * **Left-click** toggles the popover window (frameless 500×700 declared
//!   in `tauri.conf.json`).
//! * **Right-click** shows the menu: `Open PRMaster` (focuses the main
//!   window at `/prmaster`) and `Quit`.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect,
};

use crate::state::AppState;

/// Stable id for the PRMaster tray. Distinct from the zen-tools tray id
/// in [`crate::tray`] so they coexist.
pub const PRMASTER_TRAY_ID: &str = "prmaster";

/// Stable label used in `tauri.conf.json` and by the open/close commands.
pub const POPOVER_LABEL: &str = "prmaster-popover";

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
        // Left-click → toggle popover (we capture the click ourselves);
        // right-click falls through to the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "prmaster_open_main" => focus_main_window_at_prmaster(app),
            "prmaster_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                position,
                rect,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    let app = tray.app_handle().clone();
                    let p = position;
                    let r = rect;
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = toggle_popover(&app, p, r).await {
                            tracing::warn!(?e, "toggle_popover failed");
                        }
                    });
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

/// Toggle visibility of the popover window. Positions the popover under
/// the tray icon on first open (mirrors macOS menu-bar dropdown behaviour).
async fn toggle_popover(
    app: &AppHandle,
    click_pos: PhysicalPosition<f64>,
    icon_rect: Rect,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        tracing::warn!(label = POPOVER_LABEL, "popover window not found in tauri.conf.json");
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return Ok(());
    }

    let size = window.outer_size().unwrap_or_else(|_| PhysicalSize {
        width: 500,
        height: 700,
    });

    // Approximate the icon's pixel size from its physical Rect so the
    // popover can centre under it. Tauri 2 reports `rect.size` as the
    // logical-or-physical `Size` enum; both variants give us width/height.
    let (icon_w, icon_h) = match icon_rect.size {
        tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
        tauri::Size::Logical(s) => (s.width as i32, s.height as i32),
    };

    let target_x = (click_pos.x as i32 + icon_w / 2) - (size.width as i32 / 2);
    let target_y = (click_pos.y as i32) + icon_h + 4;

    let _ = window.set_position(PhysicalPosition {
        x: target_x.max(0),
        y: target_y.max(0),
    });
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

/// Hide the popover. Used by Tauri commands and by the popover's
/// `blur` listener.
pub fn hide_popover(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.hide();
    }
}

fn focus_main_window_at_prmaster(app: &AppHandle) {
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
