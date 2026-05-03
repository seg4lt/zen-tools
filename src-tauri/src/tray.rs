//! The unified Zen Tools menu-bar tray.
//!
//! One tray icon for the whole app. It's created once at startup and
//! lives the lifetime of the process — closing the main window flips
//! the activation policy to Accessory but the tray stays so the user
//! always has a visible signal the app is running, plus a way back in.
//!
//! Replaces three separate trays from earlier iterations:
//!
//! * the lazy "zen-tools" tray that came and went with perf /
//!   process-monitor activity,
//! * the permanent PRMaster tray (icon + popover + badge),
//! * the permanent dictation tray.
//!
//! All of those collapsed into the single tray here. Each tool now
//! contributes:
//!
//! 1. **Menu items** — a section with its own actions (Stop perf,
//!    Open PRMaster, Disable dictation, …). Sections appear / vanish
//!    as state changes; [`update`] is fire-and-forget and rebuilds
//!    the menu from current state.
//! 2. **Badge title** — currently only PRMaster uses this; see
//!    [`set_badge`].
//! 3. **Left-click routing** — if a tool has a popover and is the
//!    most-relevant active surface, left-click toggles its popover.
//!    Priority: process-monitor (when it has targets) → PRMaster
//!    (when enabled) → focus the main window.
//! 4. **Right-click** falls through to the menu (`show_menu_on_left_click(false)`).
//!
//! ## Threading
//!
//! AppKit `NSStatusItem` is main-thread-only. [`init`] expects to be
//! called from a main-thread context (Tauri's `setup()` is on main
//! during init, and the `run_on_main_thread` dispatch from
//! lifecycle modules covers the rest). [`update`] and [`set_badge`]
//! can be called from anywhere — they hop to the Tauri async runtime
//! internally and grab the `AppState` async mutex, then dispatch any
//! AppKit work back to the main thread.

use crate::commands;
use crate::state::AppState;
use crate::user_config::UserConfig;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, Size, WebviewUrl,
};
use tokio::sync::Mutex;

/// Stable id for the unified tray.
pub const TRAY_ID: &str = "zen-tools";

/// Window label of the Process-Monitor mini popover. Built lazily by
/// [`toggle_pm_popover`] and destroyed on dismiss/blur.
pub const PM_POPOVER_LABEL: &str = "pm-popover";

/// Window label of the PRMaster popover. Built lazily by
/// [`toggle_prmaster_popover`] and destroyed on dismiss/blur.
pub const PRMASTER_POPOVER_LABEL: &str = "prmaster-popover";

/// Embedded template PNG (auto-inverts for light/dark menu bars).
/// This is the canonical Zen Tools tray icon — the tray represents
/// the whole app, not any single tool.
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");

// ── Public API ──────────────────────────────────────────────────────

/// Build the tray once at app startup. Idempotent — calling twice is
/// harmless; the second call sees the existing tray and returns. The
/// caller is responsible for invoking this from the main thread
/// (Tauri's `setup()` already is, so passing `app.handle()` from
/// there works).
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let initial_state = MenuState::default();
    let menu = build_menu(app, &initial_state)?;
    let icon = Image::from_bytes(TRAY_ICON_PNG)?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Zen Tools")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)?;

    // Cache the live tray handle on AppState. Some downstream code
    // (notably `set_badge`) walks via `app.tray_by_id`, but holding
    // the handle here also pins the tray's NSStatusItem alongside
    // the rest of the per-app state for symmetry.
    let state_arc = app.state::<Mutex<AppState>>();
    let mut s = state_arc.blocking_lock();
    s.tray = Some(tray);

    // Run an initial reconcile so the menu reflects whatever state
    // happened to be loaded by the time we're called (e.g. PRMaster
    // already enabled from preferences). `update` is fire-and-forget;
    // it will land on the next runtime tick.
    drop(s);
    update(app);
    Ok(())
}

/// Recompute the menu from current `AppState` + `UserConfig` and
/// rebuild it on the live tray. Idempotent and fire-and-forget — safe
/// to spam from any thread / any command after a state mutation.
///
/// Examples of state mutations that trigger a rebuild today:
///   * a perf test starts or stops (`commands::perf`)
///   * the Process-Monitor target list changes
///     (`commands::process_monitor`)
///   * PRMaster is enabled / disabled (`prmaster_lifecycle`)
///   * Dictation is enabled / disabled (`dictation::lifecycle`)
pub fn update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = update_inner(&app).await {
            tracing::warn!(?e, "tray::update failed");
        }
    });
}

/// Set the badge title shown next to the tray icon. Pass an empty
/// string to clear. Currently driven by PRMaster's PR-count broadcast
/// (`prmaster_lifecycle`); other tools are welcome to layer in if a
/// future feature needs a numeric badge.
pub fn set_badge(app: &AppHandle, badge: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = if badge.is_empty() { None } else { Some(badge) };
        if let Err(e) = tray.set_title(title) {
            tracing::warn!(?e, "tray::set_badge failed");
        }
    }
}

/// Destroy the Process-Monitor popover. Called from the popover's
/// "Open Full Window" button via the `pm_popover_close` command, and
/// from the JS focus-loss listener.
pub fn destroy_pm_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(PM_POPOVER_LABEL) {
        if let Err(e) = win.destroy() {
            tracing::warn!(error = %e, "pm popover destroy failed");
        }
    }
}

/// Destroy the PRMaster popover. Called from the popover's "Open
/// Full Window" button via the `prmaster_hide_popover` command, and
/// from the JS focus-loss listener.
pub fn destroy_prmaster_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(PRMASTER_POPOVER_LABEL) {
        if let Err(e) = win.destroy() {
            tracing::warn!(error = %e, "prmaster popover destroy failed");
        }
    }
}

// ── Reconcile ───────────────────────────────────────────────────────

/// Snapshot of every signal that affects the menu shape. Computed
/// fresh on each [`update`] call.
#[derive(Default, Clone, Copy)]
struct MenuState {
    perf_running: bool,
    pm_active: bool,
    prmaster_enabled: bool,
    dictation_enabled: bool,
}

async fn update_inner(app: &AppHandle) -> tauri::Result<()> {
    let state = read_state(app).await;
    let menu = build_menu(app, &state)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

async fn read_state(app: &AppHandle) -> MenuState {
    let mut out = MenuState::default();

    // perf + PM live in the AppState mutex. `pm_is_active` only
    // queries the in-memory PM state, no I/O — cheap enough to do
    // under the same lock.
    {
        let app_state = app.state::<Mutex<AppState>>();
        let s = app_state.lock().await;
        out.perf_running = s.perf_running;
        out.pm_active = s.pm_is_active();
    }

    // Tool-disabled flags live in the persisted UserConfig blob.
    // `load_preferences` does a synchronous SQLite read; we run it
    // outside the AppState lock to keep that section short. The
    // function is cheap (single-row KV lookup) and is already used
    // on the hot close-handler path.
    let prefs = commands::preferences::load_preferences(app).ok();
    if let Some(p) = prefs {
        out.prmaster_enabled = !p.disabled_tools.iter().any(|id| id == "prmaster");
        out.dictation_enabled = !p
            .disabled_tools
            .iter()
            .any(|id| id == crate::dictation::TOOL_ID);
    } else {
        // No preferences file yet (very first launch) → defaults.
        // PRMaster and Dictation default to ENABLED so first-run
        // users see the full menu.
        let _ = app.try_state::<UserConfig>(); // touch to silence unused if cfg drops it
        out.prmaster_enabled = true;
        out.dictation_enabled = cfg!(target_os = "macos");
    }

    out
}

// ── Menu construction ───────────────────────────────────────────────

/// Build the menu for the current `MenuState`. The menu shape is:
///
/// ```text
///   Show Zen Tools
///   ───────────────
///   [perf]      Stop Perf Test
///   [pm]        Stop Monitoring
///   [prmaster]  Open PRMaster
///   [dictation] Disable dictation
///   ───────────────
///   Quit Zen Tools
/// ```
///
/// Each `[…]` line is conditional on the tool being relevant. We
/// always render the show + quit pair so the menu is never empty.
fn build_menu(app: &AppHandle, st: &MenuState) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show Zen Tools", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let stop_perf = MenuItem::with_id(
        app,
        "stop_perf",
        "Stop Perf Test",
        st.perf_running,
        None::<&str>,
    )?;
    let stop_pm = MenuItem::with_id(
        app,
        "stop_pm",
        "Stop Monitoring",
        st.pm_active,
        None::<&str>,
    )?;
    let open_prmaster = MenuItem::with_id(
        app,
        "open_prmaster",
        "Open PRMaster",
        st.prmaster_enabled,
        None::<&str>,
    )?;
    let disable_dictation = MenuItem::with_id(
        app,
        "disable_dictation",
        "Disable dictation",
        st.dictation_enabled,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Zen Tools", true, Some("Cmd+Q"))?;

    // Build with all entries always present (just disabled when
    // inapplicable) — that way the menu height doesn't jump as state
    // changes, which is less jarring than items appearing /
    // disappearing.
    Menu::with_items(
        app,
        &[
            &show,
            &sep1,
            &stop_perf,
            &stop_pm,
            &open_prmaster,
            &disable_dictation,
            &sep2,
            &quit,
        ],
    )
}

// ── Menu / click handlers ───────────────────────────────────────────

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "show" => focus_main_window(app),
        "stop_perf" => stop_perf_test(app),
        "stop_pm" => clear_pm_targets(app),
        "open_prmaster" => focus_main_window_at_prmaster(app),
        "disable_dictation" => disable_dictation(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn handle_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button,
        button_state,
        position,
        rect,
        ..
    } = event
    {
        if button != MouseButton::Left || button_state != MouseButtonState::Up {
            return;
        }
        let app = tray.app_handle().clone();
        // We have to read PM-active synchronously to decide which
        // popover to show — `tokio::sync::Mutex::try_lock` lets us
        // peek without blocking the run loop.
        let pm_active = peek_pm_active(&app);
        let prmaster_enabled = peek_prmaster_enabled(&app);

        if pm_active {
            toggle_pm_popover(&app, position, rect.size);
        } else if prmaster_enabled {
            toggle_prmaster_popover(&app, position, rect);
        } else {
            focus_main_window(&app);
        }
    }
}

/// Synchronous PM-active check using `try_lock`. If the AppState lock
/// is held by something else (perf runner mid-tick, say), default to
/// `false` — the user can click again and we'll likely succeed.
fn peek_pm_active(app: &AppHandle) -> bool {
    let state = app.state::<Mutex<AppState>>();
    // `State::inner` returns `&T` borrowing from `state`, dodging the
    // auto-deref-temporary lifetime issue we'd otherwise hit with
    // `state.try_lock()` (the State temporary would drop before the
    // guard's borrow ends).
    match state.inner().try_lock() {
        Ok(s) => s.pm_is_active(),
        Err(_) => false,
    }
}

fn peek_prmaster_enabled(app: &AppHandle) -> bool {
    commands::preferences::load_preferences(app)
        .map(|p| !p.disabled_tools.iter().any(|id| id == "prmaster"))
        .unwrap_or(true)
}

// ── Popover lifecycle (PM) ──────────────────────────────────────────

/// Toggle the PM popover. Build / position / show on first click;
/// destroy on dismiss. Tearing down rather than hiding is what keeps
/// the WKWebView's `WebContent` subprocess from leaking.
fn toggle_pm_popover(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_size: Size) {
    if app.get_webview_window(PM_POPOVER_LABEL).is_some() {
        destroy_pm_popover(app);
        return;
    }
    let win = match build_pm_popover(app) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(error = %e, "pm popover build failed");
            return;
        }
    };

    let scale = win.scale_factor().unwrap_or(1.0);
    let icon_size_phys = match tray_size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width * scale, s.height * scale),
    };
    let win_w = win.outer_size().map(|s| s.width as f64).unwrap_or(340.0);
    let icon_centre_x = tray_pos.x + icon_size_phys.0 / 2.0;
    let target_x = icon_centre_x - win_w / 2.0;
    let target_y = tray_pos.y + icon_size_phys.1 + 4.0;
    let _ = win.set_position(PhysicalPosition::new(target_x, target_y));
    let _ = win.show();
    let _ = win.set_focus();
}

fn build_pm_popover(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        PM_POPOVER_LABEL,
        WebviewUrl::App("index.html?window=pm-popover".into()),
    )
    .title("Process Monitor")
    .inner_size(340.0, 280.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .shadow(true)
    .build()
}

// ── Popover lifecycle (PRMaster) ────────────────────────────────────

fn toggle_prmaster_popover(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_rect: Rect) {
    if app.get_webview_window(PRMASTER_POPOVER_LABEL).is_some() {
        destroy_prmaster_popover(app);
        return;
    }
    let win = match build_prmaster_popover(app) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(error = %e, "prmaster popover build failed");
            return;
        }
    };
    let size = win.outer_size().unwrap_or(PhysicalSize {
        width: 500,
        height: 700,
    });
    let (icon_w, icon_h) = match tray_rect.size {
        Size::Physical(s) => (s.width as i32, s.height as i32),
        Size::Logical(s) => (s.width as i32, s.height as i32),
    };
    let target_x = (tray_pos.x as i32 + icon_w / 2) - (size.width as i32 / 2);
    let target_y = (tray_pos.y as i32) + icon_h + 4;
    let _ = win.set_position(PhysicalPosition {
        x: target_x.max(0),
        y: target_y.max(0),
    });
    let _ = win.show();
    let _ = win.set_focus();
}

fn build_prmaster_popover(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    // Loads the main shell at `/`; the React router checks the
    // window label via `isPrmasterPopover()` and redirects to
    // `/prmaster`.
    WebviewWindowBuilder::new(app, PRMASTER_POPOVER_LABEL, WebviewUrl::App("/".into()))
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

// ── Action handlers ─────────────────────────────────────────────────

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
    // Reset the route to the user's first enabled tool. The
    // `FirstToolListener` in `src/router.tsx` consumes the event.
    let _ = app.emit("app:focus-first-tool", ());
}

fn focus_main_window_at_prmaster(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit_to(
        tauri::EventTarget::any(),
        "prmaster:focus-route",
        "/prmaster",
    );
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
}

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

fn clear_pm_targets(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        {
            let state = app.state::<Mutex<AppState>>();
            let s = state.lock().await;
            s.pm_state.lock().clear_targets();
        }
        let _ = app.emit("pm:targets-cleared", ());
        update(&app);
    });
}

fn disable_dictation(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = commands::preferences::set_tool_disabled(
            crate::dictation::TOOL_ID.to_string(),
            true,
            app.clone(),
        )
        .await
        {
            tracing::warn!(?e, "tray: disable dictation failed");
        }
    });
}

