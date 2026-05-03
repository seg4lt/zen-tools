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

/// Pixel size of the pill. Logical points (Tauri's default unit on
/// macOS); device pixels follow the user's display scale.
const HUD_WIDTH: f64 = 240.0;
const HUD_HEIGHT: f64 = 44.0;
/// Distance from the top of the primary display to the top of the
/// HUD. ~12 pt clears the menu bar on most macOS setups (menu bar is
/// ~24 pt tall in the default theme; we want the HUD to sit just
/// below it).
const HUD_TOP_INSET: f64 = 12.0;

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
/// the top-centre of the primary monitor, and apply the macOS
/// always-on-top-over-fullscreen behaviour.
fn ensure_hud(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(HUD_LABEL).is_some() {
        return Ok(());
    }

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
    .inner_size(HUD_WIDTH, HUD_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .shadow(false) // we draw our own pill shadow in CSS
    .build()?;

    // Position at top-centre of the primary monitor. Done after build
    // so we can read the actual monitor geometry (handles multi-display
    // and notched displays correctly).
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        let scale = monitor.scale_factor();
        // Convert physical → logical so position() receives the same
        // unit our inner_size() used.
        let monitor_w_logical = monitor_size.width as f64 / scale;
        let monitor_x_logical = monitor_pos.x as f64 / scale;
        let monitor_y_logical = monitor_pos.y as f64 / scale;
        let target_x = monitor_x_logical + (monitor_w_logical - HUD_WIDTH) / 2.0;
        let target_y = monitor_y_logical + HUD_TOP_INSET;
        window.set_position(LogicalPosition::new(target_x, target_y))?;
    }
    // Defensive: lock the size in case the platform default ignored
    // `resizable(false)`.
    window.set_size(LogicalSize::new(HUD_WIDTH, HUD_HEIGHT))?;

    raise_above_fullscreen(&window);
    make_click_through(&window);

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
