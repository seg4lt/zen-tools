// GhosttyHostView.h — minimal NSView subclass that hosts ghostty's
// CAMetalLayer-backed terminal renderer. v1 wires the bare minimum:
// view creation, focus-on-click, key/mouse forwarding into the C API.
//
// IME support (NSTextInputClient) is intentionally deferred to a later
// milestone.

#import <Cocoa/Cocoa.h>
#import <ghostty.h>

NS_ASSUME_NONNULL_BEGIN

/// Allocates + returns a host view with no surface attached. Caller binds
/// the surface in a second step (after `ghostty_surface_new` returns).
NSView* GhosttyHostViewCreate(NSRect frame);

/// Bind a ghostty surface to the host view. The view stores the handle
/// and forwards subsequent AppKit events to the C API.
void GhosttyHostViewSetSurface(NSView* view, ghostty_surface_t surface);

/// Tear down: unbind the surface (called from the Rust drop path before
/// `ghostty_surface_free` to avoid stale-pointer dispatches from the
/// responder chain during destruction).
void GhosttyHostViewClearSurface(NSView* view);

/// Install an application-level NSEvent monitor for Cmd-modified
/// keyDown events. The monitor runs *before* AppKit dispatches the
/// event into the responder chain, lets us route the event into the
/// supplied ghostty surface, and consumes (returns nil) it so the
/// dispatch never reaches tao/wry's NSWindow/View handlers — those
/// contain `.unwrap()` / `panic!` sites in `extern "C"` callbacks
/// that abort on macOS 26 when AppKit's reentrant Cmd-key dispatch
/// hits them.
void GhosttyInstallEventMonitor(ghostty_surface_t surface);

/// Remove a previously installed monitor. Idempotent.
void GhosttyRemoveEventMonitor(void);

/// Register a callback that fires when the NSEvent monitor sees a
/// chord that the embedding host (e.g. zen-tools) wants to handle
/// instead of forwarding to ghostty. The callback is called with a
/// stable string identifier for the chord (for example `cmd-opt-f`,
/// `cmd-left-bracket`, or `cmd-shift-n`). Hosts that don't care can
/// leave this unset; the chord is consumed regardless so it never
/// reaches ghostty as an unhandled keystroke.
typedef void (*GhosttyHostKeyHookFn)(const char *chord);
void GhosttyRegisterHostKeyHookCallback(GhosttyHostKeyHookFn fn);

/// Register a callback that fires when ghostty asks the host to
/// reload its config (apprt action `RELOAD_CONFIG`). This is what
/// `ghostty_app_set_color_scheme` (and per-surface theme changes)
/// dispatch under the hood — without this hook the call is a no-op
/// because ghostty relies on the host to rebuild + push the config.
///
/// The callback receives the ghostty_app_t pointer (so it can look
/// up Rust state if it stores per-app context elsewhere) and the
/// `soft` flag from the action struct (true = scheme/conditional
/// change, false = full user-initiated reload). Implementations
/// should build a fresh ghostty_config_t and call
/// `ghostty_app_update_config(app, config)` (or
/// `ghostty_surface_update_config` per surface).
typedef void (*GhosttyReloadConfigFn)(void *app, bool soft);
void GhosttyRegisterReloadConfigCallback(GhosttyReloadConfigFn fn);

/// Register a callback that fires when ghostty emits terminal-native
/// status events that the embedding host may want to surface in its
/// own chrome (for example progress/loading, command completion,
/// bell alerts, desktop notifications, child-exit notices, and
/// renderer health).
///
/// The callback receives:
///   - `kind`: event discriminator (kept in sync with `macos.rs`)
///   - `tab_id`: owning tab, or 0 when the target could not be resolved
///   - `arg0` / `arg1`: event-specific numeric data
///   - `text0` / `text1`: optional UTF-8 strings
typedef void (*GhosttyTerminalStatusEventFn)(
    int kind,
    int tab_id,
    long long arg0,
    long long arg1,
    const char * _Nullable text0,
    const char * _Nullable text1);
void GhosttyRegisterTerminalStatusEventCallback(
    GhosttyTerminalStatusEventFn _Nullable fn);

/// Push a color-scheme change to every live `GhosttyHostView` under
/// the tab container — including split-created surfaces that the
/// Rust side never sees. Walks the actual NSView tree, so it
/// catches whatever's mounted regardless of how it got there.
///
/// `dark` is 1 for dark, 0 for light (matches
/// `ghostty_color_scheme_e`). Returns the count of surfaces
/// updated, useful for diagnostics.
int GhosttySetColorSchemeAll(int dark);

/// Replace `WryWebViewParent`'s `-[keyDown:]` IMP with a no-op via the
/// Objective-C runtime. Wry's original implementation panics on macOS
/// 26 because it dereferences `MainThreadMarker::new().unwrap()` from
/// inside an `extern "C"` ObjC method body — when AppKit re-enters the
/// dispatch path for Cmd-modified keys, the thread-identity check
/// returns None and the unwrap aborts the process via
/// `panic_cannot_unwind`. Since the original body's only effect is to
/// consult an empty main menu (Tauri terminal apps don't have one),
/// neutering it is functionally a no-op.
///
/// Safe to call multiple times. Logs via NSLog when it succeeds or
/// when the class isn't registered yet.
void GhosttyDisarmWryParentKeyDown(void);

/// Register a `ghostty_app_t` to be ticked when a wakeup arrives.
/// `GhosttyDispatchAppTick` reads this atomic; pass NULL on shutdown.
void GhosttyRegisterAppForWakeup(ghostty_surface_t app);

/// Schedule a `ghostty_app_tick` on the main queue. Safe to call
/// from any thread — the actual tick runs on main, which is what
/// libghostty requires. No-ops if no app is registered.
void GhosttyDispatchAppTick(void);

/// Register the active surface for clipboard read/write operations.
/// libghostty's read/write_clipboard_cb passes a `state` opaque token
/// but no explicit surface handle, so we keep a static reference here
/// to forward `complete_clipboard_request` to the right surface.
/// Pass NULL on teardown.
void GhosttyRegisterSurfaceForClipboard(ghostty_surface_t surface);

/// Implements `read_clipboard_cb`: read NSPasteboard text and call
/// `ghostty_surface_complete_clipboard_request` against the registered
/// surface. Returns true if a completion was queued.
bool GhosttyHandleReadClipboard(int kind, void *state);

/// Implements `write_clipboard_cb`: write the first `text/plain`
/// entry to NSPasteboard. The `confirm` arg from ghostty is ignored
/// — v1 trusts the host process implicitly.
void GhosttyHandleWriteClipboard(int kind, const void *content, unsigned long n, bool confirm);

/// Register the active host NSView so action / close-surface callbacks
/// can find their target window. Pass NULL on teardown.
void GhosttyRegisterHostView(void *view);

/// Implements the runtime's `action_cb`. Handles window-title updates,
/// fullscreen toggles, ring-bell, open-url, close-window, mouse shape
/// and visibility, etc. Returns true if the action was handled.
bool GhosttyHandleAction(void *app, void *target, void *action);

/// Implements `close_surface_cb`. Closes the window the surface lives
/// in. `process_alive` indicates whether the child process exited
/// cleanly; we currently don't show a confirm dialog (v1).
void GhosttyHandleCloseSurface(bool process_alive);

/// Register the singleton GhosttyApp so action_cb's NEW_SPLIT /
/// NEW_TAB handlers can call `ghostty_surface_new` to allocate the
/// child surface.
void GhosttyRegisterApp(void *app);

/// Replace `TaoWindow.sendEvent:` and `TaoApp.sendEvent:` IMPs with
/// pure-ObjC `[super sendEvent:]` pass-throughs. The original Rust
/// `extern "C"` IMPs panic on macOS 26 when AppKit reentrantly hands
/// them an `NSEvent` whose type integer is outside the older
/// objc2-app-kit binding's `NSEventType` enum (or modifier flags
/// outside the binding's bitfield) — `event.r#type()` /
/// `event.modifierFlags()` panic across the C ABI, hitting
/// `panic_cannot_unwind` and aborting the process.
///
/// The replacement loses tao's "drag window by background on
/// LeftMouseDown" hack — fine for a window with standard decorations.
/// AppKit's default `sendEvent:` handles everything else correctly.
///
/// Safe to call multiple times. Logs via NSLog per class.
void GhosttyDisarmTaoSendEvent(void);

// ---- Tabs ----------------------------------------------------------------
//
// Tab event kinds emitted via the registered callback.
// Keep in sync with `TabEventKind` in macos.rs.
//   1 = CREATED, 2 = FOCUSED, 3 = CLOSED, 4 = TITLE, 5 = PWD
typedef void (*GhosttyTabEventFn)(int kind, int tab_id, const char * _Nullable value);

/// Install the callback that receives tab lifecycle events. Pass NULL
/// to clear. Calls happen on the main thread.
void GhosttyRegisterTabEventCallback(GhosttyTabEventFn _Nullable fn);

/// Lazily create (or return) the tab content container — an NSView
/// hosted as a subview of `contentView`, sized inside the chrome
/// insets, that holds every tab's pane tree.
NSView *GhosttyTabContainerEnsure(NSView *contentView);

/// Update the HTML chrome insets (in points). The tab container is
/// resized accordingly. Safe to call on every HTML resize tick.
void GhosttyTabContainerSetChromeInset(double top, double right, double bottom, double left);

/// Add a root view as a new tab. Hides the previously active tab,
/// makes the new tab visible, assigns + returns a stable tab id.
int GhosttyTabAdd(NSView *root);

/// Switch to the tab with the given id. Returns true on success.
BOOL GhosttyTabFocus(int tab_id);

/// Tear down a tab. The caller must free the ghostty surface(s) under
/// the tab root before this call (or rely on `perform_close_active_tab`
/// from action_cb which handles freeing). Sets *was_last = true if no
/// tabs remain.
BOOL GhosttyTabClose(int tab_id, BOOL * _Nullable was_last);

/// Fill `out` with currently mounted tab ids in left-to-right order.
/// Returns the number written (capped at `max`).
int GhosttyTabList(int *out, int max);

/// Currently visible tab id, or 0 if none.
int GhosttyTabActiveId(void);

/// Tab action kinds dispatched from action_cb to Rust. Keep in sync
/// with `TabActionKind` in macos.rs.
///   1 = NEW (arg ignored)
///   2 = CLOSE (arg = tab_id; 0 = active)
///   3 = GOTO  (arg = ghostty GotoTab enum: positive = 1-based, negative = PREVIOUS=-1 / NEXT=-2 / LAST=-3)
typedef void (*GhosttyTabActionFn)(int kind, long arg);

/// Install the action callback. Pass NULL to clear. Calls happen on
/// the main thread. The Rust side handles surface lifetime, then calls
/// back into the tab primitives above (TabAdd/Focus/Close) to mount or
/// unmount views.
void GhosttyRegisterTabActionCallback(GhosttyTabActionFn _Nullable fn);

NS_ASSUME_NONNULL_END
