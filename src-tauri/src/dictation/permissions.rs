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

// Force AVFoundation to be linked for the dynamic `class!(AVCaptureDevice)`
// lookup in `microphone_authorization_status` / `request_microphone_access`.
// Without this, dyld doesn't load AVFoundation eagerly and the first objc
// `class!()` call returns a null Class — `objc_msgSend` to nil silently
// returns 0, which would mis-report the mic as `NotDetermined` even when
// the user has actually denied. The empty extern block is enough to force
// the framework into the load command list.
#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

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

// ── Microphone permission probing & re-prompting ──────────────────
//
// Apple keeps the rich state for mic permission in
// `AVCaptureDevice.authorizationStatus(for:)`, an Objective-C class
// method that returns a tri-state-plus enum:
//
//   * `notDetermined` (0) — TCC has no entry for this app yet; calling
//     `requestAccess(for:completionHandler:)` will fire the system
//     dialog.
//   * `restricted` (1) — managed by configuration profile / parental
//     controls; the user can't grant.
//   * `denied` (2) — TCC entry exists with the toggle off.
//   * `authorized` (3) — TCC entry exists with the toggle on.
//
// AccessKit (the Accessibility API) only exposes a boolean; mic gives
// us enough state to skip the install-id heuristic in the
// "notDetermined" case (we know there's no entry, so a plain
// `requestAccess` will prompt without needing a `tccutil reset`).

/// Tri-state-plus enum mirroring `AVAuthorizationStatus` from
/// AVFoundation. The integer discriminants match Apple's enum exactly
/// so the FFI cast is direct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAuthStatus {
    /// No TCC entry exists yet; calling `request_microphone_access`
    /// will fire the system dialog.
    NotDetermined = 0,
    /// Managed by configuration profile / parental controls; the
    /// user can't grant. UI should surface a "managed by your
    /// administrator" message rather than offer a Reset button.
    Restricted = 1,
    /// TCC entry exists with the toggle off. May be a deliberate
    /// denial (handled by `decide_autofix`) or a stale entry from a
    /// prior install.
    Denied = 2,
    /// TCC entry exists with the toggle on; recording works.
    Authorized = 3,
}

impl MicAuthStatus {
    /// Map raw integer from `AVCaptureDevice.authorizationStatus(for:)`
    /// onto the typed enum. Defends against unexpected values by
    /// reporting `NotDetermined` (the safest fallback — caller will
    /// trigger a fresh prompt rather than block silently).
    fn from_raw(raw: i64) -> Self {
        match raw {
            1 => MicAuthStatus::Restricted,
            2 => MicAuthStatus::Denied,
            3 => MicAuthStatus::Authorized,
            _ => MicAuthStatus::NotDetermined,
        }
    }

    /// Wire form for the IPC DTO. Stable strings; UI keys off them.
    pub fn as_wire_str(self) -> &'static str {
        match self {
            MicAuthStatus::NotDetermined => "notDetermined",
            MicAuthStatus::Restricted => "restricted",
            MicAuthStatus::Denied => "denied",
            MicAuthStatus::Authorized => "authorized",
        }
    }
}

/// Probe the current Microphone TCC state.
#[cfg(target_os = "macos")]
pub fn microphone_authorization_status() -> MicAuthStatus {
    use objc2::{class, msg_send, runtime::AnyObject};

    // Apple's media-type constant `AVMediaTypeAudio` is an
    // `NSString` exported by AVFoundation. `[AVCaptureDevice
    // authorizationStatusForMediaType:AVMediaTypeAudio]` returns
    // an `AVAuthorizationStatus` (NSInteger). We send the message
    // directly via objc2 instead of linking to the constant — a raw
    // `NSString` literal `"soun"` is what `AVMediaTypeAudio`
    // actually decodes to under the hood (the four-char-code for
    // sound media), and using the literal lets us skip a
    // build-time `extern static` dance.
    //
    // SAFETY: Single synchronous Objective-C message send to a
    // class method with a stable signature; no Rust references
    // escape. The returned NSInteger is plain data.
    unsafe {
        let media_type: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: c"soun".as_ptr()
        ];
        let raw: i64 = msg_send![
            class!(AVCaptureDevice),
            authorizationStatusForMediaType: media_type
        ];
        MicAuthStatus::from_raw(raw)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn microphone_authorization_status() -> MicAuthStatus {
    MicAuthStatus::NotDetermined
}

/// Trigger the macOS Microphone-permission system dialog. The
/// completion callback fires on a private AVFoundation queue once the
/// user clicks Allow / Don't Allow (or immediately if the entry is
/// already in a terminal state). `granted` reflects the post-prompt
/// status.
///
/// Calling this when the entry is already `denied` is a no-op (no
/// dialog, callback fires `false` immediately) — to force a re-prompt
/// in that case, `tccutil reset Microphone <bundle>` first to wipe
/// the entry, then call this.
///
/// The callback is `'static` because AVFoundation owns the block and
/// can invoke it after this Rust frame has long since returned.
#[cfg(target_os = "macos")]
pub fn request_microphone_access<F>(callback: F)
where
    F: FnOnce(bool) + Send + Sync + 'static,
{
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send, runtime::AnyObject};

    // AVFoundation's `requestAccessForMediaType:completionHandler:`
    // takes an Objective-C block `^(BOOL granted)`. The Objective-C
    // `BOOL` is `signed char`, NOT a C99 `_Bool`, so block2 / objc2
    // model it as `objc2::runtime::Bool` rather than Rust's `bool`.
    // Using `bool` here would generate a wrong Objective-C type
    // encoding and the runtime would reject the block.
    //
    // We wrap our FnOnce in `Mutex<Option<F>>` so we can call it
    // from inside an `Fn` block (block2 0.5 only supports `Fn`,
    // and AVFoundation guarantees a single completion call so the
    // `take()` consumes the slot exactly once in practice).
    use std::sync::Mutex;
    let cell: Mutex<Option<F>> = Mutex::new(Some(callback));
    let block = RcBlock::new(move |granted: Bool| {
        if let Some(cb) = cell.lock().ok().and_then(|mut g| g.take()) {
            cb(granted.as_bool());
        }
    });

    unsafe {
        let media_type: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: c"soun".as_ptr()
        ];
        let _: () = msg_send![
            class!(AVCaptureDevice),
            requestAccessForMediaType: media_type,
            completionHandler: &*block
        ];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_microphone_access<F>(callback: F)
where
    F: FnOnce(bool) + Send + 'static,
{
    callback(false);
}
