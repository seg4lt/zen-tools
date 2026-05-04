// ghostty-rs — safe Rust wrappers over libghostty's embedding C API.
//
// The flow you'll typically follow:
//
//   1. `init_once()` — once per process, initialises ghostty's globals.
//   2. `Config::new()` → finalize → wrap into a `RuntimeCallbacks`.
//   3. `App::new(config, callbacks)` — spawns ghostty's app.
//   4. For each window: `View::new(&app, ns_view, surface_cfg)` — attaches
//      ghostty's renderer + PTY to the supplied NSView.
//   5. Forward AppKit events into the view via the methods on `View`.
//
// Everything is `!Send` because libghostty assumes single-thread (main)
// access. The Tauri plugin runs everything inside `run_on_main_thread`.

#![cfg(target_os = "macos")]

mod app;
mod callbacks;
mod config;
mod error;
mod view;

pub use app::App;
pub use callbacks::{ClipboardKind, ClipboardRequest, RuntimeCallbacks};
pub use config::Config;
pub use error::{Error, Result};
pub use view::{GotoSplit, SplitDirection, SurfaceConfig, SurfaceContext, View};

use std::sync::OnceLock;

/// Initialise libghostty's process-globals. Safe to call from anywhere;
/// only the first call does anything.
pub fn init_once() -> Result<()> {
    static RESULT: OnceLock<Result<()>> = OnceLock::new();
    RESULT
        .get_or_init(|| {
            // ghostty_init takes (argc, argv). Pass an empty argv.
            let mut argv: [*mut std::os::raw::c_char; 1] = [std::ptr::null_mut()];
            // Safety: ghostty_init is well-defined for these args.
            let rc = unsafe { ghostty_sys::ghostty_init(0, argv.as_mut_ptr()) };
            if rc != 0 {
                Err(Error::InitFailed(rc))
            } else {
                Ok(())
            }
        })
        .clone()
}
