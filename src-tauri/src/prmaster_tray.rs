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
    webview::WebviewWindowBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl,
};

use crate::state::AppState;

/// Stable id for the PRMaster tray. Distinct from the zen-tools tray id
/// in [`crate::tray`] so they coexist.
pub const PRMASTER_TRAY_ID: &str = "prmaster";

/// Stable label for the PRMaster popover. The window is **not** declared
/// in `tauri.conf.json`; it's built on demand by [`toggle_popover`] and
/// destroyed on dismiss/blur. Pre-declaring + hiding leaks the
/// WKWebView's `WebContent` subprocess for the lifetime of the app, so
/// we mirror flowstate's popout pattern: lazy build + always destroy.
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
                    // Run the toggle synchronously on the main thread
                    // so it always wins the race against the popover's
                    // async blur handler (which goes through an IPC
                    // round-trip and lands tens of ms later). If we
                    // spawn this onto the async runtime, blur lands
                    // first → destroys the popover → toggle finds no
                    // window → builds a new one, and "click tray to
                    // dismiss" is broken.
                    if let Err(e) = toggle_popover(tray.app_handle(), position, rect) {
                        tracing::warn!(?e, "toggle_popover failed");
                    }
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
    // Destroy the popover too — the user can't summon it without the
    // tray, and it shouldn't linger (with its WKWebView subprocess) if
    // it happens to be visible at toggle-off.
    destroy_popover(app);
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

/// Toggle the popover. If one already exists, treat the click as a
/// dismiss gesture and tear it down (frees the WKWebView immediately).
/// Otherwise build a fresh popover positioned under the tray icon.
///
/// **Synchronous on purpose** — the JS-side blur handler races us via
/// IPC, and a sync toggle always wins. See call site for the rationale.
fn toggle_popover(
    app: &AppHandle,
    click_pos: PhysicalPosition<f64>,
    icon_rect: Rect,
) -> tauri::Result<()> {
    if app.get_webview_window(POPOVER_LABEL).is_some() {
        destroy_popover(app);
        return Ok(());
    }

    let window = build_popover(app)?;

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

/// Build a fresh PRMaster popover window. Mirrors the declaration that
/// used to live in `tauri.conf.json` (same dimensions, same chrome) but
/// is constructed on demand so the WKWebView's `WebContent` subprocess
/// only exists while the user is actually looking at the popover.
fn build_popover(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    // The PRMaster popover loads the main app shell at `/`; the React
    // router checks the window label via `isPrmasterPopover()` and
    // redirects to `/prmaster`. That keeps a single bundle.
    WebviewWindowBuilder::new(app, POPOVER_LABEL, WebviewUrl::App("/".into()))
        .title("PRMaster")
        .inner_size(500.0, 700.0)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()
}

/// Destroy the popover (tearing down its WKWebView). Used by Tauri
/// commands and by the JS focus-loss listener inside `PRMasterShell`.
/// Idempotent.
pub fn destroy_popover(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        if let Err(e) = window.destroy() {
            tracing::warn!(error = %e, "prmaster popover destroy failed");
        }
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
