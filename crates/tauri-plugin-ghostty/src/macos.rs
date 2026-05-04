// macos.rs — bridge between Tauri's window handle and our ObjC host
// view. The flow:
//   1. Get the NSWindow's contentView from `tauri::Window::ns_window()`.
//   2. Ensure the tab container exists as a subview of contentView.
//   3. Allocate a GhosttyHostView matching the container's bounds.
//   4. Hand the bare NSView pointer back to Rust so we can pass it into
//      `ghostty_surface_new`, then call `set_surface` to wire the
//      surface back into the view.
//   5. Mount the view as a new tab via `tab_add`.
//
// All AppKit access here MUST be on the main thread (caller's
// responsibility — typically inside `tauri::Window::run_on_main_thread`).

use std::ffi::{c_char, c_void};

use objc2::{msg_send, runtime::AnyObject};
use objc2_foundation::NSRect;

#[link(name = "ghostty_host_view", kind = "static")]
extern "C" {
    fn GhosttyHostViewCreate(frame: NSRect) -> *mut AnyObject;
    fn GhosttyHostViewSetSurface(view: *mut AnyObject, surface: *mut c_void);
    fn GhosttyInstallEventMonitor(surface: *mut c_void);
    fn GhosttyDisarmWryParentKeyDown();
    fn GhosttyDisarmTaoSendEvent();

    // Tab APIs.
    fn GhosttyTabContainerEnsure(content_view: *mut AnyObject) -> *mut AnyObject;
    fn GhosttyTabContainerSetChromeInset(top: f64, right: f64, bottom: f64, left: f64);
    fn GhosttyTabAdd(root: *mut AnyObject) -> i32;
    fn GhosttyTabFocus(tab_id: i32) -> bool;
    fn GhosttyTabClose(tab_id: i32, was_last: *mut bool) -> bool;
    fn GhosttyTabList(out: *mut i32, max: i32) -> i32;
    fn GhosttyTabActiveId() -> i32;
    fn GhosttyRegisterTabEventCallback(
        fn_ptr: Option<extern "C" fn(kind: i32, tab_id: i32, title: *const c_char)>,
    );
    fn GhosttyRegisterTabActionCallback(
        fn_ptr: Option<extern "C" fn(kind: i32, arg: i64)>,
    );

    // Embedding-host passthrough chord (currently just cmd+opt+f for
    // distraction-free toggle). The plugin's NSEvent monitor consumes
    // the chord and fires this callback with a stable identifier
    // string. See `GhosttyHostView.h::GhosttyRegisterHostKeyHookCallback`.
    fn GhosttyRegisterHostKeyHookCallback(
        fn_ptr: Option<extern "C" fn(chord: *const c_char)>,
    );

    // Reload-config action handler. Ghostty fires
    // `GHOSTTY_ACTION_RELOAD_CONFIG` after color-scheme / conditional
    // state changes; we MUST handle it (rebuild + push config) or the
    // theme switch is a visual no-op. See
    // `GhosttyHostView.h::GhosttyRegisterReloadConfigCallback`.
    fn GhosttyRegisterReloadConfigCallback(
        fn_ptr: Option<extern "C" fn(app: *mut c_void, soft: bool)>,
    );

    // Walk every live GhosttyHostView under the tab container and
    // push a color-scheme change to its surface. Catches split-
    // created surfaces that aren't in Rust's `PluginState.surfaces`
    // map (those are allocated entirely on the C side from
    // `perform_new_split`). Returns the count of surfaces touched.
    fn GhosttySetColorSchemeAll(dark: i32) -> i32;
}

/// Ensure the tab content container is mounted as a subview of the
/// supplied window's contentView. Returns the container's NSView*.
///
/// HISTORY: an earlier version of this function unconditionally
/// cleared `NSWindowStyleMaskFullSizeContentView` (mask bit
/// `1 << 15 = 0x8000`). The original tauri-terminal app uses
/// `decorations: true` with a normal AppKit title bar, and the
/// stripping was a "make the contentView geometry match the visible
/// area" simplification.
///
/// We removed that strip because zen-tools' window config uses
/// `titleBarStyle: "Overlay"` + `hiddenTitle: true` (a chromeless
/// look — no native title bar visible). Stripping
/// `NSWindowStyleMaskFullSizeContentView` re-asserts the native
/// title bar at runtime, which is the wrong UX for a host that
/// chose the overlay style. The frontend's chrome-inset feedback
/// loop (`terminalSetChromeInset` driven by the route container's
/// `getBoundingClientRect().top`) already accounts for whatever
/// HTML chrome lives above the terminal, so the NSView ends up
/// in the right place either way — full-size-content-view does
/// not cause cell clipping when the inset is measured against the
/// HTML container, not against the window edge.
///
/// If a future host needs the strip back, expose it as an opt-in
/// via a `set_strip_full_size_content_view(true)` plugin command
/// rather than re-enabling it here unconditionally.
///
/// # Safety
/// `ns_window` must be a non-null NSWindow*. Must be called on main.
pub unsafe fn ensure_tab_container(ns_window: *mut c_void) -> *mut c_void {
    let win = ns_window as *mut AnyObject;

    let content_view: *mut AnyObject = msg_send![win, contentView];
    let container = GhosttyTabContainerEnsure(content_view);
    container as *mut c_void
}

/// Allocate a fresh GhosttyHostView with the given frame. Returned
/// pointer is unowned by Rust — adding it to a view via `tab_add` (or
/// `addSubview:`) keeps it alive.
///
/// # Safety
/// Must be called on main.
pub unsafe fn create_host_view(frame: NSRect) -> *mut c_void {
    GhosttyHostViewCreate(frame) as *mut c_void
}

/// Bind the libghostty surface handle into the view so it can dispatch
/// AppKit events.
///
/// # Safety
/// `view` must be a host view returned by `create_host_view`. `surface`
/// must outlive the view (or be cleared via `clear_surface` first).
pub unsafe fn set_surface(view: *mut c_void, surface: *mut c_void) {
    GhosttyHostViewSetSurface(view as *mut AnyObject, surface);
}

/// Install the application-level Cmd-key event monitor (see
/// `GhosttyHostView.m` for the rationale — bypasses tao/wry's panic-prone
/// extern "C" keyDown handlers on macOS 26).
///
/// # Safety
/// `surface` must be a valid `ghostty_surface_t` and must outlive the
/// monitor.
pub unsafe fn install_event_monitor(surface: *mut c_void) {
    GhosttyInstallEventMonitor(surface);
}

/// Replace `WryWebViewParent`'s `keyDown:` IMP with a no-op via the
/// Objective-C runtime. See `GhosttyHostView.m` for the full rationale —
/// short version: wry's original calls `MainThreadMarker::new().unwrap()`
/// inside an `extern "C"` ObjC method which aborts the process when
/// AppKit's reentrant Cmd-key dispatch (macOS 26) hits it.
///
/// Must be called AFTER wry has registered the `WryWebViewParent` class
/// (i.e. after the webview has been created — `terminal_new` time is
/// safe).
///
/// # Safety
/// Touches the Objective-C runtime's method table. Safe in steady state;
/// must run on the main thread to avoid racing with the runtime's class
/// finalisation.
pub unsafe fn disarm_wry_parent_key_down() {
    GhosttyDisarmWryParentKeyDown();
}

/// Replace `TaoWindow.sendEvent:` and `TaoApp.sendEvent:` with
/// pure-ObjC pass-throughs to super. See `GhosttyHostView.m` for the
/// rationale (short version: tao's Rust IMPs `event.r#type()` panic
/// on macOS 26 inside an `extern "C"` boundary).
///
/// # Safety
/// Touches the Objective-C runtime's method table. Must run on the
/// main thread (caller's responsibility).
pub unsafe fn disarm_tao_send_event() {
    GhosttyDisarmTaoSendEvent();
}

// ---- Tab APIs ------------------------------------------------------------

/// Tab event kinds emitted by the ObjC side via the registered
/// callback. Keep in sync with the enum in `GhosttyHostView.m`.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabEventKind {
    Created = 1,
    Focused = 2,
    Closed = 3,
    Title = 4,
}

impl TabEventKind {
    pub fn from_i32(v: i32) -> Option<Self> {
        Some(match v {
            1 => Self::Created,
            2 => Self::Focused,
            3 => Self::Closed,
            4 => Self::Title,
            _ => return None,
        })
    }
}

/// Add a root view as a new tab. Returns the assigned tab id (>0).
///
/// # Safety
/// `root` must be a valid NSView* that is NOT yet attached to a
/// superview. Must run on main.
pub unsafe fn tab_add(root: *mut c_void) -> i32 {
    GhosttyTabAdd(root as *mut AnyObject)
}

/// Switch focus to a different tab. Returns true if the tab existed.
pub unsafe fn tab_focus(tab_id: i32) -> bool {
    GhosttyTabFocus(tab_id)
}

/// Remove a tab from the container (without freeing surfaces — caller
/// is responsible). Returns `(success, was_last_tab)`.
pub unsafe fn tab_close(tab_id: i32) -> (bool, bool) {
    let mut was_last = false;
    let ok = GhosttyTabClose(tab_id, &mut was_last);
    (ok, was_last)
}

/// Snapshot of currently mounted tab ids in left-to-right order.
pub unsafe fn tab_list() -> Vec<i32> {
    let mut buf = vec![0i32; 64];
    let n = GhosttyTabList(buf.as_mut_ptr(), buf.len() as i32);
    buf.truncate(n.max(0) as usize);
    buf
}

/// Currently active tab id (or 0 if no tabs).
pub unsafe fn tab_active_id() -> i32 {
    GhosttyTabActiveId()
}

/// Update the HTML chrome insets (in points). Safe to call repeatedly.
pub unsafe fn tab_container_set_chrome_inset(top: f64, right: f64, bottom: f64, left: f64) {
    GhosttyTabContainerSetChromeInset(top, right, bottom, left);
}

/// Install the tab event callback. Calls land on the main thread.
pub unsafe fn register_tab_event_callback(
    fn_ptr: extern "C" fn(kind: i32, tab_id: i32, title: *const c_char),
) {
    GhosttyRegisterTabEventCallback(Some(fn_ptr));
}

/// Tab action kinds dispatched by ghostty's action_cb to Rust. Keep in
/// sync with `GhosttyTabAction*` in the C side.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabActionKind {
    New = 1,
    Close = 2,
    Goto = 3,
}

impl TabActionKind {
    pub fn from_i32(v: i32) -> Option<Self> {
        Some(match v {
            1 => Self::New,
            2 => Self::Close,
            3 => Self::Goto,
            _ => return None,
        })
    }
}

/// Install the tab action callback. Called by ghostty's action_cb when
/// it sees NEW_TAB / CLOSE_TAB / GOTO_TAB. Runs on the main thread.
pub unsafe fn register_tab_action_callback(
    fn_ptr: extern "C" fn(kind: i32, arg: i64),
) {
    GhosttyRegisterTabActionCallback(Some(fn_ptr));
}

/// Install the embedding-host key-hook callback. Fires when the
/// NSEvent monitor sees a chord that the host wants to handle
/// instead of forwarding to ghostty (currently just `cmd+opt+f`,
/// emitted as the C string `"cmd-opt-f"`). Runs on the main thread.
pub unsafe fn register_host_key_hook_callback(
    fn_ptr: extern "C" fn(chord: *const c_char),
) {
    GhosttyRegisterHostKeyHookCallback(Some(fn_ptr));
}

/// Install the reload-config callback. Fires when ghostty's action_cb
/// dispatches `GHOSTTY_ACTION_RELOAD_CONFIG` — most importantly after
/// `ghostty_app_set_color_scheme()`. Runs on the main thread.
pub unsafe fn register_reload_config_callback(
    fn_ptr: extern "C" fn(app: *mut c_void, soft: bool),
) {
    GhosttyRegisterReloadConfigCallback(Some(fn_ptr));
}

/// Push a color-scheme change to every live surface (every
/// `GhosttyHostView` mounted under the tab container — including
/// split-created panes the Rust side doesn't know about). Returns
/// the count of surfaces touched. MUST be called on the main thread
/// (callee touches AppKit views via subviews iteration).
pub unsafe fn set_color_scheme_all(dark: bool) -> i32 {
    GhosttySetColorSchemeAll(if dark { 1 } else { 0 })
}

/// Hide or show the macOS standard window buttons (close / minimize /
/// zoom — collectively "the traffic lights") on `ns_window`. Used by
/// embedding hosts to enter true distraction-free mode where even
/// the AppKit-painted controls disappear.
///
/// CSS can't reach these — they're rendered by AppKit on top of the
/// WKWebView via `titleBarStyle: "Overlay"` — so we toggle their
/// `hidden` flag via `[NSWindow standardWindowButton:]`.
///
/// # Safety
/// `ns_window` must be a non-null NSWindow*. Must run on the main
/// thread (AppKit affinity).
pub unsafe fn set_traffic_lights_hidden(ns_window: *mut c_void, hidden: bool) {
    let win = ns_window as *mut AnyObject;

    // NSWindowButton enum:
    //   NSWindowCloseButton       = 0
    //   NSWindowMiniaturizeButton = 1
    //   NSWindowZoomButton        = 2
    // (NSToolbarButton, NSDocumentIconButton, NSDocumentVersionsButton
    // exist too but aren't traffic lights.)
    for kind in [0u64, 1, 2] {
        let btn: *mut AnyObject = msg_send![win, standardWindowButton: kind];
        if !btn.is_null() {
            let _: () = msg_send![btn, setHidden: hidden];
        }
    }
}
