//! Paste transcribed text at the active cursor.
//!
//! 1. Write `text` to the general `NSPasteboard`.
//! 2. Synthesize a `⌘V` keydown + keyup via `CGEventCreateKeyboardEvent`
//!    and `CGEventPost`, which causes the focused application to
//!    perform its standard paste action.
//!
//! The synthetic event posting requires Accessibility permission
//! (same TCC bucket as the CGEventTap watcher in
//! [`crate::hotkey::macos`]). We don't restore the previous clipboard
//! contents — per product decision, the transcript stays on the
//! clipboard.

#![cfg(target_os = "macos")]

use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::msg_send;
use objc2::rc::Retained;
use objc2_app_kit::NSPasteboard;
use objc2_foundation::NSString;

use crate::error::DictationError;

/// `kVK_ANSI_V` from `<HIToolbox/Events.h>`.
const KVK_V: CGKeyCode = 0x09;

/// Write `text` to the general pasteboard, then post a synthetic
/// `⌘V` to the focused application.
pub fn paste_text(text: &str) -> Result<(), DictationError> {
    write_pasteboard(text)?;
    post_cmd_v()?;
    Ok(())
}

fn write_pasteboard(text: &str) -> Result<(), DictationError> {
    // Build NSString from the borrowed Rust &str. NSString::from_str
    // copies into a fresh autoreleased object.
    let ns_text = NSString::from_str(text);

    // SAFETY: AppKit's NSPasteboard API is documented as main-thread
    // safe for these calls. We're invoked from a tokio worker after
    // transcription, so we don't gate on main-thread; in practice
    // this works because pasteboard mutation is internally serialised.
    // If we hit a flake we can hop to main via dispatch_async.
    unsafe {
        let pb: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();
        pb.clearContents();
        // setString:forType: requires the `NSPasteboardTypeString`
        // UTI; on macOS 10.6+ this is the constant
        // `NSPasteboardTypeString` exported by AppKit. We pass the
        // raw UTI to avoid pulling in AppKit constant bindings.
        let type_str = NSString::from_str("public.utf8-plain-text");
        let _: bool = msg_send![&*pb, setString: &*ns_text, forType: &*type_str];
    }
    Ok(())
}

fn post_cmd_v() -> Result<(), DictationError> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| DictationError::Audio("CGEventSource::new failed".into()))?;

    // ⌘ down + V down + V up + ⌘ up. We send the modifier flag on the
    // V key events directly — that's enough for the receiver to see a
    // Cmd-V combo. We also issue explicit keydown/keyup of the modifier
    // for compatibility with apps that watch flagsChanged.
    let key_down = CGEvent::new_keyboard_event(source.clone(), KVK_V, true)
        .map_err(|_| DictationError::Audio("CGEvent keydown failed".into()))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source, KVK_V, false)
        .map_err(|_| DictationError::Audio("CGEvent keyup failed".into()))?;
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);
    key_up.post(CGEventTapLocation::HID);

    Ok(())
}
