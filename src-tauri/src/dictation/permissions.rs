//! macOS Accessibility (TCC) permission probe.
//!
//! Dictation needs Accessibility access to install its global
//! `CGEventTap` for the right-⌘ hotkey. macOS keys TCC permissions by
//! **bundle identifier** — so any rename (e.g. `com.zen-tools.app` →
//! `com.seg4lt.zen-tools`) invalidates every previously-granted
//! permission for the app, even though `/Applications/Zen Tools.app`
//! is the same physical bundle.
//!
//! Without a pre-check, every `lifecycle::start` call would attempt
//! `CGEventTap` creation and macOS would pop the
//! "Zen Tools would like to control this computer using Accessibility
//! features" dialog every single launch. Instead we probe via
//! `AXIsProcessTrusted()` first: if not trusted, skip the tap install,
//! log it, and let the React frontend (or the user) drive the
//! re-grant flow without us spamming the system dialog.
//!
//! NOT used: `AXIsProcessTrustedWithOptions(prompt: true)`. That API
//! triggers the system dialog as a side effect, which we deliberately
//! avoid on every boot. The user grants via System Settings → Privacy
//! & Security → Accessibility, then restarts (or we expose a "retry
//! install" Tauri command later that re-invokes `lifecycle::start`).

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// Returns true iff the current process has Accessibility
/// permission. macOS-only — returns `false` on every other platform
/// so callers naturally short-circuit.
pub fn is_accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
