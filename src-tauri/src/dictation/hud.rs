//! Dynamic Island-style overlay shown while dictation is active.
//!
//! A small black rounded-pill window pinned to the top-centre of the
//! primary display, always-on-top (including over fullscreen apps),
//! that mirrors the three-state pipeline: **Hidden / Recording /
//! Transcribing**. Replaces the previous menu-bar mic tray.
//!
//! ## Resource lifecycle
//!
//! On `set_state(Recording)` / `set_state(Transcribing)` the HUD
//! window is built (via [`WebviewWindowBuilder`]) if not already
//! present, positioned at the top-centre of the primary monitor, and
//! then signalled with the new status via the
//! `dictation:hud-status` event so the React side can render the
//! right copy.
//!
//! On `set_state(Hidden)` the HUD window is **destroyed** — not just
//! hidden — so the underlying `WKWebView` subprocess (Cocoa
//! `WebContent`) is reaped and its memory + sandbox slot released.
//! `WebviewWindow::destroy` is what frees the resources; `hide` only
//! orders-out the NSWindow.
//!
//! ## Threading
//!
//! All AppKit operations (window creation, repositioning, destroy)
//! run on the Cocoa main thread via
//! [`AppHandle::run_on_main_thread`]. Concurrent `set_state` calls
//! are serialised by the run loop dispatch queue.
//!
//! ## Always-on-top above fullscreen
//!
//! Tauri's `always_on_top(true)` raises the window above other normal
//! apps but **not** above fullscreen apps. We add a native call to
//! configure `NSWindowCollectionBehavior` with
//! `canJoinAllSpaces | fullScreenAuxiliary | stationary` so the HUD
//! also floats over fullscreen apps and follows the user across
//! Spaces. See [`raise_above_fullscreen`].

#![cfg(target_os = "macos")]

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// Stable window label used by `get_webview_window` and `destroy`.
pub const HUD_LABEL: &str = "dictation-hud";

/// User-visible HUD phases. Identical to the previous tray
/// `HudState` enum so the call sites in `mod.rs::on_hotkey` stay
/// readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HudState {
    /// No recording or transcription in flight — HUD destroyed.
    Hidden,
    /// Mic is open and accumulating samples.
    Recording,
    /// Whisper is running and we're about to paste.
    Transcribing,
}

impl HudState {
    /// Wire string emitted to the HUD webview so it can render the
    /// right copy. The HUD subscribes to `dictation:hud-status`.
    fn wire(self) -> &'static str {
        match self {
            HudState::Hidden => "idle",
            HudState::Recording => "recording",
            HudState::Transcribing => "transcribing",
        }
    }
}

/// Pixel size of the notch-style overlay. Logical points (Tauri's
/// default unit on macOS); device pixels follow the user's display
/// scale.
const HUD_WIDTH: f64 = 280.0;
/// Height of the visible content row (waveform + label). This is the
/// portion the user actually reads — sits flush at the bottom of the
/// pill regardless of menu-bar thickness so the layout is identical
/// on notched (~37 pt menu bar) and non-notched (~24 pt) machines.
const HUD_CONTENT_HEIGHT: f64 = 40.0;

/// Dispatch a state change to the HUD. Idempotent and safe to call
/// from any thread (everything is hopped to the Cocoa main thread
/// internally).
pub fn set_state(app: &AppHandle, state: HudState) {
    let app_for_closure = app.clone();
    let _ = app.run_on_main_thread(move || {
        match state {
            HudState::Hidden => destroy_hud(&app_for_closure),
            HudState::Recording | HudState::Transcribing => {
                if let Err(e) = ensure_hud(&app_for_closure) {
                    tracing::warn!(?e, "dictation: HUD ensure failed");
                    return;
                }
                // Re-fire the status event regardless of whether we
                // built the window or it was already up — covers the
                // Recording → Transcribing transition.
                use tauri::Emitter as _;
                if let Err(e) = app_for_closure.emit("dictation:hud-status", state.wire()) {
                    tracing::warn!(?e, "dictation: emit hud-status failed");
                }
            }
        }
    });
}

/// Build the HUD window if it doesn't already exist, position it at
/// the top-centre of the primary monitor (covering the menu bar),
/// and apply the macOS always-on-top-over-fullscreen behaviour.
fn ensure_hud(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(HUD_LABEL).is_some() {
        return Ok(());
    }

    // The pill extends from the very top of the screen down past the
    // menu bar — the upper section overlays the menu bar (which is
    // mostly empty whitespace centred above the active app menus and
    // status icons; on notched MacBooks the centre is just the
    // notch/camera anyway) and the lower section is the visible
    // content row.
    let total_height = menu_bar_thickness() + HUD_CONTENT_HEIGHT;

    // The webview loads `index.html?window=dictation-hud`; the React
    // entry-point in `src/main.tsx` reads the query-param and short-
    // circuits to the HUD component instead of mounting the full app.
    // Same pattern as `pm-popover`.
    let window = WebviewWindowBuilder::new(
        app,
        HUD_LABEL,
        WebviewUrl::App("index.html?window=dictation-hud".into()),
    )
    .title("Dictation")
    .inner_size(HUD_WIDTH, total_height)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .shadow(false)
    .build()?;

    // Position at the top-centre of the primary monitor with **no**
    // y offset — the pill's top edge sits flush at y=0 (i.e. flush
    // with the screen's physical top edge, behind the menu bar in
    // window stacking terms). We then raise the window's NSLevel
    // above the menu bar so it actually paints over it (see
    // `raise_above_menu_bar`); without that step macOS would clip
    // our top half.
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        let scale = monitor.scale_factor();
        let monitor_w_logical = monitor_size.width as f64 / scale;
        let monitor_x_logical = monitor_pos.x as f64 / scale;
        let monitor_y_logical = monitor_pos.y as f64 / scale;
        let target_x = monitor_x_logical + (monitor_w_logical - HUD_WIDTH) / 2.0;
        let target_y = monitor_y_logical;
        window.set_position(LogicalPosition::new(target_x, target_y))?;
    }
    // Defensive: lock the size in case the platform default ignored
    // `resizable(false)`. Use the same total_height we built with.
    window.set_size(LogicalSize::new(HUD_WIDTH, total_height))?;

    raise_above_menu_bar(&window);
    raise_above_fullscreen(&window);
    make_click_through(&window);

    // Hand the visible content height to the React side so its CSS
    // anchors the waveform + label at the bottom of the pill instead
    // of the centre — that way the menu-bar overlap stays empty
    // black space, identical on notched and non-notched displays.
    use tauri::Emitter as _;
    let _ = window.emit(
        "dictation:hud-layout",
        serde_json::json!({
            "content_height": HUD_CONTENT_HEIGHT,
            "menu_bar_height": menu_bar_thickness(),
        }),
    );

    Ok(())
}

/// Destroy the HUD if present. `destroy` (not `hide`) so the
/// `WebContent` subprocess is reaped and its memory released — the
/// user's request was that nothing stay running once dictation isn't
/// active.
fn destroy_hud(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(HUD_LABEL) {
        if let Err(e) = window.destroy() {
            tracing::warn!(?e, "dictation: HUD destroy failed");
        } else {
            tracing::debug!("dictation: HUD destroyed");
        }
    }
}

/// Configure the `NSWindowCollectionBehavior` so the HUD floats over
/// **fullscreen** apps and follows the user across Spaces. Tauri's
/// `always_on_top(true)` only raises the window above normal apps;
/// fullscreen requires `fullScreenAuxiliary`.
///
/// Called immediately after window creation. If anything goes wrong
/// the HUD still works at standard always-on-top level — we log and
/// move on.
fn raise_above_fullscreen(window: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(e) => {
            tracing::warn!(?e, "dictation: ns_window() failed; HUD won't float over fullscreen");
            return;
        }
    };
    if ns_window_ptr.is_null() {
        return;
    }

    // NSWindowCollectionBehavior bitfield — values copied from
    // <AppKit/NSWindow.h>:
    //   canJoinAllSpaces       = 1 << 0
    //   stationary             = 1 << 4 (don't follow Mission Control)
    //   fullScreenAuxiliary    = 1 << 8
    // Combined we get a window that:
    //   * appears on every Space the user switches to (canJoinAllSpaces),
    //   * doesn't get pulled into a separate Space when the user
    //     enters Mission Control (stationary),
    //   * floats above fullscreen apps as an auxiliary panel
    //     (fullScreenAuxiliary).
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const STATIONARY: usize = 1 << 4;
    const FULLSCREEN_AUXILIARY: usize = 1 << 8;
    let behavior: usize = CAN_JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUXILIARY;

    // SAFETY: `ns_window()` returns a valid `NSWindow*` (or null,
    // already filtered). `setCollectionBehavior:` is documented
    // main-thread-safe and we're on main here. The selector takes a
    // `NSUInteger` (= `usize` on 64-bit Darwin).
    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
    }
}

/// Live menu-bar height in logical points. Returns
/// `NSStatusBar.systemStatusBar.thickness`, which already accounts
/// for notched MacBooks (~37 pt) versus standard machines (~24 pt).
/// Falls back to 24 pt if the AppKit call somehow fails.
fn menu_bar_thickness() -> f64 {
    use objc2::{class, msg_send, runtime::AnyObject};
    unsafe {
        let status_bar: *mut AnyObject = msg_send![class!(NSStatusBar), systemStatusBar];
        if status_bar.is_null() {
            return 24.0;
        }
        // `thickness` returns CGFloat (= f64 on aarch64 / x86_64
        // Darwin). Newer SDKs declare it as `CGFloat` directly.
        let thickness: f64 = msg_send![status_bar, thickness];
        if thickness > 0.0 {
            thickness
        } else {
            24.0
        }
    }
}

/// Raise the HUD's NSWindow level so it paints **over** the macOS
/// menu bar.
///
/// macOS ships these named levels (from `<AppKit/NSWindow.h>`):
///
/// | name                       | numeric |
/// |----------------------------|---------|
/// | `NSNormalWindowLevel`      | 0       |
/// | `NSFloatingWindowLevel`    | 3       |
/// | `NSMainMenuWindowLevel`    | 24      |
/// | `NSStatusWindowLevel`      | 25      |
/// | `NSPopUpMenuWindowLevel`   | 101     |
/// | `NSScreenSaverWindowLevel` | 1000    |
///
/// The menu bar lives at `NSMainMenuWindowLevel` (24). Tauri's
/// `always_on_top(true)` only puts us at `NSFloatingWindowLevel` (3),
/// so the menu bar still draws on top of us. Promoting to
/// `NSStatusWindowLevel` (25) is exactly what status-bar items use
/// and is the appropriate slot for a small persistent overlay — it
/// gets us above the menu bar without going so high that we'd
/// occlude the screen-saver, accessibility hover-cards, or system
/// modal panels.
fn raise_above_menu_bar(window: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    // SAFETY: `ns_window()` returns a valid `NSWindow*` (or null,
    // already filtered). `setLevel:` is documented main-thread-safe;
    // we're called from the Cocoa main thread via
    // `run_on_main_thread` upstream. The selector takes a single
    // `NSInteger` (= `isize` on 64-bit Darwin).
    const NS_STATUS_WINDOW_LEVEL: isize = 25;
    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setLevel: NS_STATUS_WINDOW_LEVEL];
    }
}

/// Make the HUD's underlying NSWindow click-through. The HUD is a
/// passive status indicator — it shouldn't steal mouse events from
/// whatever app the user is interacting with underneath. Without
/// this, clicking on the pill would be intercepted by the WKWebView
/// (which has nothing to do with it but still receives the event).
fn make_click_through(window: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    // SAFETY: same justification as `raise_above_fullscreen`. The
    // selector takes a single `BOOL`; on Apple platforms `BOOL` is
    // `bool`.
    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setIgnoresMouseEvents: true];
    }
}
