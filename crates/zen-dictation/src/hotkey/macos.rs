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
    kCFRunLoopCommonModes, CFRunLoop, CFRunLoopAddSource, CFRunLoopRemoveSource, CFRunLoopSource,
};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventType, EventField,
};
use parking_lot::Mutex;

// `CGEventTapEnable` flips the tap on/off without tearing down the
// mach port. Used in `TapHandle::Drop` to stop event delivery
// immediately, before we remove the source from the run loop and let
// the wrapper types release their retains.
extern "C" {
    fn CGEventTapEnable(
        tap: core_foundation::mach_port::CFMachPortRef,
        enable: bool,
    );
}

use crate::error::DictationError;
use crate::hotkey::HotkeyHandle;
use crate::manager::HotkeyEvent;

/// Right-Command HID keycode (kVK_RightCommand). Matches the value
/// Carbon defines in `<HIToolbox/Events.h>`. We deliberately filter
/// to the right ⌘ side — left ⌘ is keycode `0x37` and is left
/// completely inert for the dictation gesture.
const KVK_RIGHT_COMMAND: i64 = 0x36;

/// A right-⌘ press counts as a "tap" only if the down→up cycle
/// completes within this duration. Anything longer is treated as a
/// deliberate hold or a chord press, not as the first leg of the
/// tap-then-hold gesture.
const TAP_MAX_DURATION: Duration = Duration::from_millis(300);

/// Maximum gap between a clean tap-up and the next press-down for
/// the next press to count as the "hold leg" of the gesture. Beyond
/// this the chain is considered broken and the user has to start
/// over.
const TAP_TO_HOLD_WINDOW: Duration = Duration::from_millis(500);

/// How long the second leg of the gesture must be held (after a
/// preceding tap) before we fire `HotkeyEvent::Toggle`.
const LONG_PRESS_THRESHOLD: Duration = Duration::from_millis(500);

/// Trait alias for the boxed callback closure. Kept as a type alias so
/// we can store it inside an `Arc<Mutex<...>>` without naming `dyn` at
/// every use site.
type EventCallback = dyn FnMut(HotkeyEvent) + Send + 'static;

/// Drop this to remove the tap from the run loop and stop receiving
/// events.
///
/// **Important:** the previous version of this struct relied on
/// `Drop` of `CGEventTap` + `CFRunLoopSource` to detach the tap.
/// That isn't enough — `CFRunLoopAddSource` retains the source, so
/// when our wrappers release their retain on drop the run loop still
/// holds the source and the tap keeps firing in the background.
///
/// The proper teardown order is:
///   1. `CGEventTapEnable(port, false)` — stops the tap from
///      delivering events immediately, even before the run-loop
///      source is removed.
///   2. `CFRunLoopRemoveSource(rl, source, mode)` — drops the run
///      loop's retain on the source.
///   3. Our `_source` drop releases our retain — refcount hits 0 and
///      the source is freed.
///   4. Our `_tap` drop releases our retain on the mach port —
///      refcount hits 0 and the port is freed.
pub struct TapHandle {
    tap: CGEventTap<'static>,
    source: CFRunLoopSource,
    /// The run loop the source was added to. Stored so `Drop` can
    /// remove the source from exactly that loop (the main one).
    run_loop: CFRunLoop,
}

impl Drop for TapHandle {
    fn drop(&mut self) {
        unsafe {
            // 1. Stop event delivery first.
            CGEventTapEnable(self.tap.mach_port.as_concrete_TypeRef(), false);
            // 2. Remove the source from the run loop, releasing its
            //    retain. Without this the source — and therefore the
            //    underlying mach port + tap — would survive until the
            //    process exits.
            CFRunLoopRemoveSource(
                self.run_loop.as_concrete_TypeRef(),
                self.source.as_concrete_TypeRef(),
                kCFRunLoopCommonModes,
            );
        }
        tracing::info!("dictation: CGEventTap removed from run loop");
        // 3. & 4. happen automatically when `self.source` and
        //         `self.tap` go out of scope.
    }
}

#[derive(Default)]
struct TapState {
    /// `Some(t)` while right-⌘ is currently held (between the
    /// keydown and keyup `flagsChanged` events). `None` while idle.
    current_press_down: Option<Instant>,
    /// Set if any non-modifier key fires `keyDown` while right-⌘ is
    /// being held. Once polluted, the press cannot count as a tap or
    /// as the "hold" leg of the gesture — this is what stops ⌘C,
    /// ⌘V, ⌘⇥ from accidentally toggling dictation. Reset on every
    /// new press-down.
    polluted: bool,
    /// Time of the most recent **clean** tap completion (right-⌘ up
    /// after a press shorter than `TAP_MAX_DURATION` with no chord).
    /// Cleared on Toggle, on chord-pollution, and on any press that
    /// exceeds `TAP_MAX_DURATION` (which breaks the chain).
    last_tap_up: Option<Instant>,
    /// `true` once the long-press timer for the current press has
    /// fired and emitted Toggle. Stops the release handler from
    /// then misclassifying the same press as a (very long) tap.
    long_press_fired: bool,
}

/// Install a CGEventTap on the current thread's run loop and dispatch
/// `HotkeyEvent::Toggle` whenever the user completes the
/// **tap-then-long-press** gesture on the right ⌘ key. Must be called
/// from the Cocoa main thread.
///
/// The state machine lives in [`TapState`] (see field-level docs).
/// Two CGEventTap event types feed it:
///
/// * `flagsChanged` (filtered to right-⌘ only) — drives the press
///   down/up transitions and schedules the long-press timer when the
///   incoming press is in the "hold" window after a clean tap.
/// * `keyDown` — sets the pollution flag. Modifier keys never fire
///   `keyDown`, only `flagsChanged`, so any incoming `keyDown` while
///   right-⌘ is held implies a chord (⌘C, ⌘V, ⌘⇥, …) and disqualifies
///   the press from counting as part of the gesture.
pub fn start_double_tap_watcher<F>(on_event: F) -> Result<HotkeyHandle, DictationError>
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
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy, event_type, event| {
            match event_type {
                CGEventType::FlagsChanged => {
                    handle_flags_changed(event, &state_for_tap, &cb_for_tap);
                }
                CGEventType::KeyDown => {
                    handle_key_down(&state_for_tap);
                }
                _ => {}
            }
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

    let run_loop = CFRunLoop::get_current();
    unsafe {
        CFRunLoopAddSource(
            run_loop.as_concrete_TypeRef(),
            source.as_concrete_TypeRef(),
            kCFRunLoopCommonModes,
        );
    }
    tap.enable();

    tracing::info!("dictation: CGEventTap installed for tap-then-hold right-⌘ gesture");

    Ok(HotkeyHandle {
        inner: TapHandle {
            tap,
            source,
            run_loop,
        },
    })
}

/// Handle a `flagsChanged` event for the right-⌘ key.
fn handle_flags_changed(
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

    let now = Instant::now();
    let mut s = state.lock();

    match (s.current_press_down.is_some(), cmd_held) {
        (false, true) => {
            // ── Right-⌘ DOWN ─────────────────────────────────────
            s.current_press_down = Some(now);
            s.polluted = false;
            s.long_press_fired = false;

            // If we have a clean tap completed within the
            // tap→hold window, this press is a candidate for the
            // "hold leg" — schedule the long-press timer.
            let is_hold_candidate = s
                .last_tap_up
                .map(|t| now.duration_since(t) <= TAP_TO_HOLD_WINDOW)
                .unwrap_or(false);
            if !is_hold_candidate {
                return; // Just a press; wait for release to classify.
            }

            // Spawn an OS thread (NOT tokio::spawn — this callback
            // runs on the Cocoa main thread which has no tokio
            // reactor; that mistake silently swallowed events
            // earlier in development).
            //
            // We capture **this press's** down-timestamp (`now`) and
            // only fire if `current_press_down` is still the same
            // value when the timer wakes. Without that guard a stale
            // timer from a previous press could fire on a new press
            // (Inner.current_press_down had been re-populated by the
            // new keydown), causing a spurious toggle. The
            // timestamp acts as a generation token.
            //
            // Lifecycle: if the watcher is dropped via
            // `dictation::lifecycle::stop` while a timer is pending,
            // the timer still wakes after the 500 ms sleep; it
            // observes `current_press_down != Some(spawned_at)` (or
            // `None`) and exits without firing. The Arcs it holds
            // are released and the OS thread terminates. No leak.
            let spawned_for = now;
            let state = state.clone();
            let cb = cb.clone();
            std::thread::spawn(move || {
                std::thread::sleep(LONG_PRESS_THRESHOLD);
                let mut s = state.lock();
                if s.current_press_down == Some(spawned_for)
                    && !s.polluted
                    && !s.long_press_fired
                {
                    s.long_press_fired = true;
                    s.last_tap_up = None; // chain consumed
                    drop(s);
                    tracing::info!("dictation: tap-then-hold gesture fired");
                    (cb.lock())(HotkeyEvent::Toggle);
                }
            });
        }
        (true, false) => {
            // ── Right-⌘ UP ──────────────────────────────────────
            let down = s.current_press_down.take();
            let was_polluted = s.polluted;
            s.polluted = false;
            let long_pressed = s.long_press_fired;
            s.long_press_fired = false;

            // The hold leg already fired during this press — the
            // gesture is complete, the timer cleared `last_tap_up`,
            // we're done.
            if long_pressed {
                return;
            }

            let press_duration = down
                .map(|t| now.duration_since(t))
                .unwrap_or_default();

            // Polluted (chord) or held too long → not a clean tap.
            // Break the chain so a stale tap can't pair with a
            // future hold.
            if was_polluted || press_duration > TAP_MAX_DURATION {
                s.last_tap_up = None;
                return;
            }

            // Clean tap. Record the timestamp so the next press
            // (if it lands within `TAP_TO_HOLD_WINDOW`) becomes a
            // hold candidate.
            s.last_tap_up = Some(now);
        }
        _ => {}
    }
}

/// Handle a `keyDown` event of any kind. Modifier keys never fire
/// `keyDown` (they fire `flagsChanged`), so any event reaching us
/// here is a non-modifier key press — i.e. the right-⌘ press is part
/// of a chord and must not be counted as a tap or as the hold leg.
fn handle_key_down(state: &Arc<Mutex<TapState>>) {
    let mut s = state.lock();
    if s.current_press_down.is_some() {
        s.polluted = true;
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
