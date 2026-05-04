// callbacks.rs — runtime callbacks dispatched from libghostty's event
// loop. Each Rust closure is heap-allocated and stored behind the C
// `void *userdata` pointer. C trampolines bridge into the closures.

use ghostty_sys::*;

#[derive(Debug, Clone, Copy)]
pub enum ClipboardKind {
    Standard,
    Selection,
}

#[derive(Debug, Clone, Copy)]
pub enum ClipboardRequest {
    Paste,
    Osc52Read,
    Osc52Write,
}

/// Callbacks ghostty invokes from its event loop. All callbacks must be
/// `Send + Sync` because libghostty calls them from internal threads;
/// the Tauri plugin's `wakeup` impl typically dispatches the actual work
/// onto the main thread via `run_on_main_thread`.
pub struct RuntimeCallbacks {
    /// Asks the host loop to call `App::tick` soon. The Tauri plugin's
    /// implementation typically posts to the main thread.
    pub wakeup: Box<dyn Fn() + Send + Sync>,
    /// Read text from the clipboard for a given kind/request reason. The
    /// minimal v1 impl only needs to support standard clipboard pastes.
    pub read_clipboard: Box<dyn Fn(ClipboardKind, ClipboardRequest) -> Option<String> + Send + Sync>,
    /// Write text to the clipboard.
    pub write_clipboard: Box<dyn Fn(ClipboardKind, &str, bool) + Send + Sync>,
    /// Surface close request (the OS asked the surface to go away).
    pub close_surface: Box<dyn Fn(bool) + Send + Sync>,
}

impl RuntimeCallbacks {
    /// Convenience: build callbacks where the action_cb is unhandled
    /// (returns false). Useful for v1 where no app-level actions are
    /// wired up yet.
    pub fn no_op() -> Self {
        Self {
            wakeup: Box::new(|| {}),
            read_clipboard: Box::new(|_, _| None),
            write_clipboard: Box::new(|_, _, _| {}),
            close_surface: Box::new(|_| {}),
        }
    }
}

/// Build a `ghostty_runtime_config_s` whose `userdata` points at the
/// supplied callbacks. The caller is responsible for keeping the
/// `Box<RuntimeCallbacks>` alive for the entire lifetime of the
/// `ghostty_app_t`.
pub(crate) fn build_runtime_config(
    callbacks: &RuntimeCallbacks,
) -> ghostty_runtime_config_s {
    ghostty_runtime_config_s {
        userdata: callbacks as *const RuntimeCallbacks as *mut std::ffi::c_void,
        // Selection clipboard maps to NSPasteboardNameFind (see the
        // C side's clipboard_for_kind). Setting true tells ghostty
        // to actually exercise the selection-clipboard path on
        // mouse-select / shift-click.
        supports_selection_clipboard: true,
        wakeup_cb: Some(trampoline_wakeup),
        action_cb: Some(trampoline_action),
        read_clipboard_cb: Some(trampoline_read_clipboard),
        confirm_read_clipboard_cb: Some(trampoline_confirm_read_clipboard),
        write_clipboard_cb: Some(trampoline_write_clipboard),
        close_surface_cb: Some(trampoline_close_surface),
    }
}

// --- Trampolines ----------------------------------------------------------
// SAFETY: `userdata` is always `&RuntimeCallbacks` because we constructed
// the runtime config with that pointer. We never give it elsewhere.
//
// Each trampoline body runs inside `catch_unwind` so a panic inside our
// callback closures is logged + swallowed instead of crossing the C ABI
// boundary (which aborts the process under the panic_cannot_unwind
// machinery, swallowing the original message).

unsafe fn cbs<'a>(userdata: *mut std::ffi::c_void) -> Option<&'a RuntimeCallbacks> {
    // ghostty does call some runtime callbacks (notably wakeup_cb)
    // with userdata=NULL — observed during mouse selection. Skip
    // silently rather than dereferencing and aborting the process.
    if userdata.is_null() { return None; }
    Some(&*(userdata as *const RuntimeCallbacks))
}

fn log_panic(name: &str, payload: Box<dyn std::any::Any + Send>) {
    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        format!("non-string panic payload (type id {:?})", (*payload).type_id())
    };
    eprintln!(">>> [ghostty trampoline panic] in {name}: {msg}");
}

// Dispatch a `ghostty_app_tick` on the main thread. The actual app
// pointer is registered separately via `register_app_for_wakeup`
// because it's only known AFTER `ghostty_app_new` returns. This
// runs on libghostty's wakeup-callback thread; the C side dispatches
// via libdispatch onto the main queue.
extern "C" {
    fn GhosttyDispatchAppTick();
    pub fn GhosttyRegisterAppForWakeup(app: *mut std::ffi::c_void);
    pub fn GhosttyRegisterApp(app: *mut std::ffi::c_void);
    pub fn GhosttyRegisterSurfaceForClipboard(surface: *mut std::ffi::c_void);
    fn GhosttyHandleReadClipboard(kind: i32, state: *mut std::ffi::c_void) -> bool;
    fn GhosttyHandleWriteClipboard(
        kind: i32,
        content: *const std::ffi::c_void,
        n: usize,
        confirm: bool,
    );
    fn GhosttyHandleAction(
        app: *mut std::ffi::c_void,
        target: *const std::ffi::c_void,
        action: *const std::ffi::c_void,
    ) -> bool;
    fn GhosttyHandleCloseSurface(process_alive: bool);
}

unsafe extern "C" fn trampoline_wakeup(userdata: *mut std::ffi::c_void) {
    if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // ALWAYS dispatch a tick — userdata may be null in some
        // ghostty internal call sites, but the app pointer is stable
        // and registered separately via GhosttyRegisterAppForWakeup.
        // Without this, ghostty's queued work never runs and the
        // terminal freezes after a few hundred lines of output.
        GhosttyDispatchAppTick();
        if let Some(c) = cbs(userdata) { (c.wakeup)(); }
    })) {
        log_panic("wakeup", p);
    }
}

unsafe extern "C" fn trampoline_action(
    app: ghostty_app_t,
    target: ghostty_target_s,
    action: ghostty_action_s,
) -> bool {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Forward to the ObjC handler which knows how to talk to
        // AppKit (NSWindow.title, toggleFullScreen:, NSBeep, etc.).
        // We pass pointers to the local stack copies of target/action;
        // the C side reads fields immediately and doesn't retain.
        GhosttyHandleAction(
            app as *mut std::ffi::c_void,
            &target as *const _ as *const std::ffi::c_void,
            &action as *const _ as *const std::ffi::c_void,
        )
    }));
    match r {
        Ok(v) => v,
        Err(p) => {
            log_panic("action", p);
            false
        }
    }
}

unsafe extern "C" fn trampoline_read_clipboard(
    _userdata: *mut std::ffi::c_void,
    kind: ghostty_clipboard_e,
    state: *mut std::ffi::c_void,
) -> bool {
    let r = std::panic::catch_unwind(|| {
        // Read NSPasteboard via the C helper. It calls
        // `ghostty_surface_complete_clipboard_request` against the
        // surface registered in `GhosttyRegisterSurfaceForClipboard`.
        GhosttyHandleReadClipboard(kind as i32, state)
    });
    match r {
        Ok(v) => v,
        Err(p) => {
            log_panic("read_clipboard", p);
            false
        }
    }
}

unsafe extern "C" fn trampoline_confirm_read_clipboard(
    _userdata: *mut std::ffi::c_void,
    _str: *const std::os::raw::c_char,
    _state: *mut std::ffi::c_void,
    _request: ghostty_clipboard_request_e,
) {
    if let Err(p) = std::panic::catch_unwind(|| {
        // v1: no confirmation UI — accept everything.
    }) {
        log_panic("confirm_read_clipboard", p);
    }
}

unsafe extern "C" fn trampoline_write_clipboard(
    _userdata: *mut std::ffi::c_void,
    kind: ghostty_clipboard_e,
    contents: *const ghostty_clipboard_content_s,
    n: usize,
    confirm: bool,
) {
    if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Write to NSPasteboard via the C helper. v1 ignores the
        // user-supplied write_clipboard closure (in RuntimeCallbacks)
        // because the macOS-specific NSPasteboard logic lives ObjC-side
        // anyway and that's where ghostty's contents struct is easiest
        // to walk.
        GhosttyHandleWriteClipboard(
            kind as i32,
            contents as *const std::ffi::c_void,
            n,
            confirm,
        );
    })) {
        log_panic("write_clipboard", p);
    }
}

unsafe extern "C" fn trampoline_close_surface(
    userdata: *mut std::ffi::c_void,
    process_alive: bool,
) {
    if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Forward to the ObjC handler which closes the registered
        // window. The user-supplied callback (if any) is also called
        // for hosts that want to add custom shutdown logic.
        GhosttyHandleCloseSurface(process_alive);
        if let Some(c) = cbs(userdata) { (c.close_surface)(process_alive); }
    })) {
        log_panic("close_surface", p);
    }
}
