// app.rs — wraps `ghostty_app_t`. Single-threaded; main-thread only.

use crate::{
    callbacks::{build_runtime_config, RuntimeCallbacks},
    config::Config,
    error::{Error, Result},
};
use ghostty_sys::{
    ghostty_app_free, ghostty_app_new, ghostty_app_set_color_scheme,
    ghostty_app_set_focus, ghostty_app_t, ghostty_app_tick,
    ghostty_app_update_config,
    ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_DARK,
    ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_LIGHT,
    ghostty_runtime_config_s,
};

pub struct App {
    inner: ghostty_app_t,
    // Keep both the callbacks AND the runtime-config struct alive for
    // libghostty's lifetime. ghostty_app_new takes a `const ghostty_
    // runtime_config_s *` and is observed to dereference fields off it
    // (notably `userdata`) on later calls — i.e. it stores the pointer
    // rather than copying. If we let either box drop, the next runtime
    // callback panics dereferencing freed memory.
    _callbacks: Box<RuntimeCallbacks>,
    _runtime: Box<ghostty_runtime_config_s>,
}

impl App {
    /// Create a new app from a finalized Config + RuntimeCallbacks.
    /// Consumes `config`. Caller must have already called `crate::init_once`.
    pub fn new(config: Config, callbacks: RuntimeCallbacks) -> Result<Self> {
        let cbs_box = Box::new(callbacks);
        let runtime_box = Box::new(build_runtime_config(&cbs_box));
        let raw_config = config.into_raw();

        // Safety: ghostty_app_new takes ownership of `raw_config` and
        // (per observed behavior) keeps a pointer to our runtime_config
        // struct, dereferencing `userdata` on later callbacks. We
        // therefore keep the box alive for the lifetime of `App`.
        let inner = unsafe { ghostty_app_new(&*runtime_box, raw_config) };
        if inner.is_null() {
            return Err(Error::AppCreateFailed);
        }
        // Register the app pointer with the C-side dispatcher so
        // wakeup-thread fires can post a tick onto the main queue.
        // Without this, libghostty's queued work (PTY drain, render
        // requests, scrollback prune) never runs and the terminal
        // freezes after enough output (~100 lines reliably).
        unsafe {
            crate::callbacks::GhosttyRegisterAppForWakeup(inner as *mut std::ffi::c_void);
            // Action handlers (NEW_SPLIT, NEW_TAB) need the app to
            // call ghostty_surface_new for the child surface.
            crate::callbacks::GhosttyRegisterApp(inner as *mut std::ffi::c_void);
        }
        Ok(Self {
            inner,
            _callbacks: cbs_box,
            _runtime: runtime_box,
        })
    }

    /// Process one tick of ghostty's event loop. Call from the main
    /// thread, ideally on a CVDisplayLink callback or similar — we'll
    /// drive it from `wakeup_cb` for now.
    pub fn tick(&self) {
        // Safety: `inner` is non-null and owned by `self`.
        unsafe { ghostty_app_tick(self.inner) };
    }

    pub fn set_focus(&self, focused: bool) {
        unsafe { ghostty_app_set_focus(self.inner, focused) };
    }

    pub fn set_color_scheme(&self, dark: bool) {
        let mode = if dark {
            ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_DARK
        } else {
            ghostty_color_scheme_e_GHOSTTY_COLOR_SCHEME_LIGHT
        };
        unsafe { ghostty_app_set_color_scheme(self.inner, mode) };
    }

    /// Push an updated `Config` to a running app. Used by the apprt's
    /// `RELOAD_CONFIG` action handler — ghostty fires that action
    /// after `set_color_scheme()` to ask us to re-derive colors with
    /// the new conditional state. Ghostty reads from `config` (per
    /// `*const Config` in the FFI signature) and we retain ownership;
    /// drop frees ours.
    pub fn update_config(&self, config: &Config) {
        unsafe { ghostty_app_update_config(self.inner, config.raw()) };
    }

    /// Raw pointer access — for `View::new` and host-side FFI calls
    /// that need to dispatch directly (e.g. from a queued main-thread
    /// closure where keeping a `&App` borrow alive would compete
    /// with the host's own state lock).
    pub fn raw(&self) -> ghostty_app_t {
        self.inner
    }
}

// Safety: ghostty assumes main-thread-only access. Tauri's State requires
// Send+Sync; we satisfy the bound and rely on the host (the Tauri plugin)
// to dispatch all calls onto the main thread. If a non-main-thread call
// slips through, ghostty will crash — but that's a host-side bug, not a
// soundness issue in this wrapper.
unsafe impl Send for App {}
unsafe impl Sync for App {}

impl Drop for App {
    fn drop(&mut self) {
        if !self.inner.is_null() {
            // Unregister BEFORE freeing so any in-flight wakeup
            // dispatch sees null and skips the tick.
            unsafe {
                crate::callbacks::GhosttyRegisterAppForWakeup(std::ptr::null_mut());
                ghostty_app_free(self.inner);
            }
        }
    }
}
