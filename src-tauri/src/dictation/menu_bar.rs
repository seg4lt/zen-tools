//! Permanent macOS menu-bar tray for the dictation feature.
//!
//! Created when the user enables Dictation (driven from
//! [`crate::dictation::lifecycle::start`]) and torn down when they
//! disable it (`lifecycle::stop`). Lives separately from:
//!
//! * [`crate::tray`] — the lazy zen-tools tray that comes and goes
//!   with perf / process-monitor activity, and
//! * [`crate::prmaster_tray`] — the always-on PRMaster tray.
//!
//! ## Why we need it
//!
//! Closing the main window puts the app into Accessory mode (no
//! Dock icon) so the right-⌘ tap-then-hold gesture keeps working in
//! the background. Without a menu-bar item the user has no visible
//! signal the app is still running, no way to reopen the main
//! window, and no way to disable dictation without remembering to
//! force-quit. The tray gives them all three.
//!
//! Distinct from the live dictation HUD ([`crate::dictation::hud`])
//! which is a separate top-centre overlay shown ONLY during a
//! recording / transcription cycle. The HUD says "I'm capturing
//! audio right now"; this tray says "the dictation feature is
//! armed".

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

/// Stable id keyed by [`AppHandle::tray_by_id`] / `remove_tray_by_id`.
pub const TRAY_ID: &str = "dictation";

/// Embedded template PNG. Renders a stylised microphone (44×44,
/// `isTemplate = true`) so macOS auto-tints to match light/dark
/// menu-bar appearance. Distinct from `tray-icon.png` (zen-tools
/// generic) and `pr-tray-icon.png` (PRMaster) so the user can
/// differentiate at a glance.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../../icons/dictation-tray-icon.png");

/// Build the tray and stash it under [`TRAY_ID`] on the global tray
/// manager. Idempotent — calling twice is a no-op because the second
/// call sees the existing tray.
///
/// **Threading**: AppKit `NSStatusItem` mutation must happen on the
/// Cocoa main thread. The caller is responsible for arranging that
/// (lifecycle::start dispatches via `run_on_main_thread`).
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let menu = build_menu(app)?;
    let icon = Image::from_bytes(TRAY_ICON_PNG)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Dictation — tap then hold right ⌘ to toggle")
        .menu(&menu)
        // We don't have a popover for dictation; show the menu on
        // BOTH left and right click for the simplest possible
        // affordance.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "dictation_show_main" => focus_main_window(app),
            "dictation_disable" => disable_dictation(app),
            "dictation_quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    tracing::info!("dictation: menu-bar tray installed");
    Ok(())
}

/// Drop the tray on the **Cocoa main thread**. Releasing
/// `NSStatusItem` from a tokio worker crashes hard — same constraint
/// as the existing zen-tools / PRMaster trays.
pub fn tear_down(app: &AppHandle) {
    if app.tray_by_id(TRAY_ID).is_none() {
        return;
    }
    if let Some(tray) = app.remove_tray_by_id(TRAY_ID) {
        // Move ownership to a main-thread closure so AppKit releases
        // it from the right thread. The drop in the closure is what
        // actually frees the underlying NSStatusItem.
        let _ = app.run_on_main_thread(move || {
            drop(tray);
        });
    }
    tracing::info!("dictation: menu-bar tray removed");
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show =
        MenuItem::with_id(app, "dictation_show_main", "Show Zen Tools", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let disable = MenuItem::with_id(
        app,
        "dictation_disable",
        "Disable dictation",
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "dictation_quit", "Quit Zen Tools", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &sep1, &disable, &sep2, &quit])
}

/// Bring the main window to the front. Mirrors the same dance
/// `prmaster_tray::focus_main_window_at_prmaster` does (unminimise →
/// show → focus → flip activation policy back to Regular so the
/// Dock icon reappears).
fn focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
}

/// Persist `disabled_tools += "dictation"` and call into the live
/// lifecycle so the CGEventTap is uninstalled, the HUD is destroyed,
/// and this tray itself goes away. Uses the same `set_tool_disabled`
/// command path the Settings switch uses, so the two paths can never
/// drift in behaviour.
fn disable_dictation(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Direct call into the command body, not through `invoke`,
        // because we have an `AppHandle` already and we don't want
        // to round-trip via JSON.
        if let Err(e) = crate::commands::preferences::set_tool_disabled(
            crate::dictation::TOOL_ID.to_string(),
            true,
            app.clone(),
        )
        .await
        {
            tracing::warn!(?e, "dictation: tray disable failed");
        }
    });
}
