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
    fn AXIsProcessTrustedWithOptions(
        options: core_foundation::dictionary::CFDictionaryRef,
    ) -> bool;
    #[cfg(target_os = "macos")]
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
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

/// Trigger the macOS Accessibility-permission system dialog. Returns
/// the post-call trusted state (which is whatever was set BEFORE the
/// user clicks; macOS doesn't block).
///
/// Important caveat — calling this when an Accessibility entry already
/// exists in TCC (granted or denied) is a NO-OP: macOS will not
/// re-prompt for an entry that exists, regardless of its on/off
/// state. To force a re-prompt we have to first wipe the entry via
/// `tccutil reset Accessibility <bundle-id>` (see
/// `reset_accessibility_tcc_entry` below) and then call this.
#[cfg(target_os = "macos")]
pub fn prompt_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    // SAFETY: `kAXTrustedCheckOptionPrompt` is a process-lifetime
    // constant `CFStringRef` exported by ApplicationServices. We hold
    // it under `wrap_under_get_rule` so retain/release counts stay
    // balanced.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = CFBoolean::true_value();
    let dict = CFDictionary::from_CFType_pairs(&[(key, value.as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) }
}

/// Stub for non-macOS targets — there is no Accessibility prompt to
/// trigger off-platform.
#[cfg(not(target_os = "macos"))]
pub fn prompt_accessibility() -> bool {
    false
}

/// Wipe the TCC entry for `service` (e.g. `"Accessibility"`,
/// `"Microphone"`) belonging to the given bundle id, by shelling out
/// to `tccutil(1)`.
///
/// Why this exists: once a TCC entry exists for a bundle id (whether
/// the toggle is on or off), macOS refuses to re-prompt — the
/// `AXIsProcessTrustedWithOptions(prompt: true)` call becomes a
/// no-op. The user is left with a dead toggle in System Settings (it
/// often does nothing because the entry's cdhash doesn't match the
/// current binary, e.g. after an unsigned-build reinstall) and no
/// path back to a re-prompt. Resetting the entry is the documented
/// escape hatch (`man tccutil`).
///
/// `tccutil reset <service> <bundle-id>` is a normal user-level
/// command — no admin password needed, no entitlement required. It
/// fails with a non-zero exit if the service name is unknown to TCC
/// or the bundle id is malformed; we surface stderr in that case so
/// the UI can show the underlying reason.
#[cfg(target_os = "macos")]
pub fn reset_tcc_entry(service: &str, bundle_id: &str) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/tccutil")
        .args(["reset", service, bundle_id])
        .output()
        .map_err(|e| format!("spawn tccutil: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tccutil reset {service} {bundle_id} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn reset_tcc_entry(_service: &str, _bundle_id: &str) -> Result<(), String> {
    Err("tccutil is macOS-only".to_string())
}

/// Open the System Settings (macOS 13+) / System Preferences pane for
/// a TCC privacy category. `pane` is one of the well-known anchor
/// strings: `"Privacy_Accessibility"`, `"Privacy_Microphone"`, etc.
///
/// We use the `x-apple.systempreferences:` URL scheme rather than the
/// shell-out + simulated keystrokes approach. The URL scheme has been
/// stable since macOS 10.10 and is what Apple's own apps use to
/// deep-link.
#[cfg(target_os = "macos")]
pub fn open_privacy_pane(pane: &str) -> Result<(), String> {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn open: {e}"))
}

#[cfg(not(target_os = "macos"))]
pub fn open_privacy_pane(_pane: &str) -> Result<(), String> {
    Err("System Settings deep-link is macOS-only".to_string())
}
