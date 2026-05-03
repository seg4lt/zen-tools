//! Long-press right-Cmd watcher backed by `CGEventTap`.
//!
//! ## Why CGEventTap (and not `tauri-plugin-global-shortcut` or `rdev`)
//!
//! * `tauri-plugin-global-shortcut` requires a non-modifier key in the
//!   chord (e.g. ⌘+P). We need to detect a *modifier-only* press.
//! * `rdev` uses CGEventTap under the hood but maps both Command keys
//!   to a single virtual key — left vs right is not distinguishable.
//!
//! Talking to CGEventTap directly is ~80 lines, gives us the raw HID
//! keycode (`0x36` = right-Cmd), and lets us drive a precise long-press
//! state machine.
//!
//! ## Threading
//!
//! `CGEventTapCreate` must be called on the Cocoa main thread, and the
//! tap must be added to the main run loop. The Tauri `setup()` callback
//! runs on main, so we expect callers to invoke
//! [`start_long_press_watcher`] from there. We dispatch user events
//! onto the tokio runtime via the supplied callback so handlers don't
//! block the run loop.
//!
//! ## Permissions
//!
//! CGEventTap requires Accessibility permission in System Settings →
//! Privacy & Security → Accessibility. Without it the tap is created
//! disabled and our callback never fires. We trigger the prompt via
//! `AXIsProcessTrustedWithOptions` on first start so the user sees the
//! system dialog at the right moment.

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use core_foundation::base::TCFType;
use core_foundation::runloop::{
    kCFRunLoopCommonModes, CFRunLoop, CFRunLoopAddSource, CFRunLoopSource,
};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventType, EventField,
};
use parking_lot::Mutex;

use crate::error::DictationError;
use crate::hotkey::HotkeyHandle;
use crate::manager::HotkeyEvent;

/// Right-Command HID keycode (kVK_RightCommand). Matches the value
/// Carbon defines in `<HIToolbox/Events.h>`.
const KVK_RIGHT_COMMAND: i64 = 0x36;

/// Threshold before we treat a hold as a "long press". 500 ms
/// matches the user spec and is forgiving enough that normal ⌘+key
/// shortcuts (~tens of ms) never trip it.
const LONG_PRESS_THRESHOLD: Duration = Duration::from_millis(500);

/// Trait alias for the boxed callback closure. Kept as a type alias so
/// we can store it inside an `Arc<Mutex<...>>` without naming `dyn` at
/// every use site.
type EventCallback = dyn FnMut(HotkeyEvent) + Send + 'static;

/// Drop this to remove the tap from the run loop and stop receiving
/// events.
pub struct TapHandle {
    // CGEventTap and the corresponding CFRunLoopSource keep themselves
    // alive via run-loop registration; explicit `drop` is enough to
    // detach. We hold them so the destructor runs.
    _tap: CGEventTap<'static>,
    _source: CFRunLoopSource,
}

#[derive(Default)]
struct TapState {
    pressed_at: Option<Instant>,
    long_press_active: bool,
}

/// Install a CGEventTap on the current thread's run loop and dispatch
/// long-press events to `on_event`. Must be called from the Cocoa
/// main thread.
pub fn start_long_press_watcher<F>(on_event: F) -> Result<HotkeyHandle, DictationError>
where
    F: FnMut(HotkeyEvent) + Send + 'static,
{
    // Trigger the Accessibility prompt the first time we run. If the
    // user denies, the tap will be created disabled — we surface that
    // via tracing rather than failing hard, so a subsequent grant in
    // System Settings can be picked up on next launch.
    prompt_accessibility();

    let cb: Arc<Mutex<EventCallback>> = Arc::new(Mutex::new(on_event));
    let state: Arc<Mutex<TapState>> = Arc::new(Mutex::new(TapState::default()));

    let cb_for_tap = cb.clone();
    let state_for_tap = state.clone();
    let tap = CGEventTap::new(
        CGEventTapLocation::HID,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::FlagsChanged],
        move |_proxy, _event_type, event| {
            handle_event(event, &state_for_tap, &cb_for_tap);
            // ListenOnly taps must return a borrowed event; we don't
            // mutate or replace it. The `None` return tells the OS to
            // pass the event through unchanged.
            None
        },
    )
    .map_err(|()| DictationError::Audio("CGEventTap::new failed (Accessibility?)".into()))?;

    let source = tap
        .mach_port
        .create_runloop_source(0)
        .map_err(|()| DictationError::Audio("CFMachPortCreateRunLoopSource failed".into()))?;

    unsafe {
        CFRunLoopAddSource(
            CFRunLoop::get_current().as_concrete_TypeRef(),
            source.as_concrete_TypeRef(),
            kCFRunLoopCommonModes,
        );
    }
    tap.enable();

    tracing::info!("dictation: CGEventTap installed for right-⌘ long press");

    Ok(HotkeyHandle {
        inner: TapHandle {
            _tap: tap,
            _source: source,
        },
    })
}

fn handle_event(
    event: &CGEvent,
    state: &Arc<Mutex<TapState>>,
    cb: &Arc<Mutex<EventCallback>>,
) {
    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
    if keycode != KVK_RIGHT_COMMAND {
        return;
    }
    let flags = event.get_flags();
    let cmd_held = flags.contains(CGEventFlags::CGEventFlagCommand);

    let mut s = state.lock();
    match (s.pressed_at.is_some(), cmd_held) {
        (false, true) => {
            // Right-Command went down. Start the long-press timer.
            s.pressed_at = Some(Instant::now());
            s.long_press_active = false;
            // We're on the Cocoa main run-loop thread here, which is
            // NOT a tokio runtime context — `tokio::spawn` panics
            // ("no reactor running"). Use a plain OS thread for the
            // 500 ms wait; it's a single short-lived timer per
            // keypress so the cost is negligible (and we don't have
            // to thread a `tokio::runtime::Handle` through the
            // crate).
            let state = state.clone();
            let cb = cb.clone();
            std::thread::spawn(move || {
                std::thread::sleep(LONG_PRESS_THRESHOLD);
                let mut s = state.lock();
                let still_held = s
                    .pressed_at
                    .map(|t| t.elapsed() >= LONG_PRESS_THRESHOLD)
                    .unwrap_or(false);
                if still_held && !s.long_press_active {
                    s.long_press_active = true;
                    drop(s);
                    (cb.lock())(HotkeyEvent::LongPressStart);
                }
            });
        }
        (true, false) => {
            // Right-Command released.
            let was_long = s.long_press_active;
            s.pressed_at = None;
            s.long_press_active = false;
            drop(s);
            if was_long {
                (cb.lock())(HotkeyEvent::Released);
            }
            // Sub-threshold release: caller never saw a Start, so no
            // Released event to send. This is intentional — short
            // taps stay reserved for normal ⌘ shortcut use.
        }
        _ => {}
    }
}

// Both symbols come from `ApplicationServices.framework` (technically
// `HIServices` underneath). `AXIsProcessTrustedWithOptions` is a real
// function; `kAXTrustedCheckOptionPrompt` is a **`CFStringRef`
// constant**, NOT a function — declaring it as `fn() -> CFStringRef`
// and calling it interprets the string-ref's bit pattern as a code
// pointer and crashes immediately (SIGBUS on aarch64). Hence the
// `static` declaration below.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(
        options: core_foundation::dictionary::CFDictionaryRef,
    ) -> bool;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

/// Trigger the macOS Accessibility-permission prompt if the process
/// isn't already trusted. Idempotent and side-effect free if granted.
fn prompt_accessibility() {
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

    let trusted = unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) };
    if !trusted {
        tracing::warn!(
            "dictation: Accessibility permission not granted — \
             long-press hotkey will not fire until the user enables \
             it in System Settings → Privacy & Security → Accessibility"
        );
    }
}
