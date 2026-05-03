//! Tap-then-long-press hotkey detection on the right ⌘ key.
//!
//! macOS implementation lives in [`macos`]. A non-mac stub is provided
//! so callers don't have to cfg-wall every reference.

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::start_double_tap_watcher;

#[cfg(not(target_os = "macos"))]
pub fn start_double_tap_watcher<F>(_on_event: F) -> Result<HotkeyHandle, crate::DictationError>
where
    F: FnMut(crate::manager::HotkeyEvent) + Send + 'static,
{
    Err(crate::DictationError::NotSupported)
}

/// RAII handle that keeps the platform-specific watcher alive. Drop it
/// to stop listening.
///
/// On macOS this contains a [`CGEventTap`](core_graphics::event::CGEventTap)
/// and a [`CFRunLoopSource`](core_foundation::runloop::CFRunLoopSource),
/// neither of which is auto-`Send`/`Sync` (they wrap raw `*mut` Core
/// Foundation handles). We assert thread-safety by hand:
///
/// * The tap is created and registered on the Cocoa main thread inside
///   the Tauri `setup()` callback, and we never call methods on it
///   afterwards.
/// * Drop simply releases the underlying CFRetain'd objects via the
///   `core-foundation` types' `Drop` impls; the runtime tolerates
///   release from a non-main thread for these specific types.
///
/// In practice the handle is moved exactly once — into the
/// `DictationManager` — and never accessed across threads after that.
pub struct HotkeyHandle {
    // The wrapped tap handle is kept alive purely so its `Drop` impl
    // detaches from the run loop when the handle is released. Nothing
    // ever reads it directly — `#[allow(dead_code)]` silences the
    // "field is never read" lint that this RAII pattern triggers.
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    pub(crate) inner: macos::TapHandle,
    #[cfg(not(target_os = "macos"))]
    #[allow(dead_code)]
    pub(crate) _phantom: (),
}

// SAFETY: see HotkeyHandle doc comment — we never operate on the
// underlying CGEventTap from multiple threads concurrently.
unsafe impl Send for HotkeyHandle {}
unsafe impl Sync for HotkeyHandle {}
