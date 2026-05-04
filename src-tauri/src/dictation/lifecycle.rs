//! Start / stop the always-on dictation machinery.
//!
//! Mirrors `prmaster_lifecycle` so the per-tool kill-switch in
//! `Preferences::disabled_tools` can flip the dictation feature on
//! and off live, without an app restart.
//!
//! Always-on pieces (when the tool is enabled):
//!
//! 1. The long-press right-⌘ **CGEventTap** that drives the
//!    record/transcribe/paste pipeline.
//! 2. A background **Whisper Base model download** (one-shot, only
//!    fires if `<app_data>/models/ggml-base.bin` is missing).
//!
//! Both must light up only when the user has the dictation tool
//! enabled. This module exposes [`start`] and [`stop`] so the
//! startup flow in `lib.rs` and the live `set_tool_disabled` command
//! can flip them atomically.
//!
//! ## Stop semantics
//!
//! [`stop`] **must actually stop the hotkey** — that's the user's
//! whole reason for the toggle. Dropping
//! [`zen_dictation::HotkeyHandle`] runs its `Drop` impl, which:
//!
//! * disables the underlying `CGEventTap` via `CGEventTapEnable(_, false)`,
//! * removes the run-loop source via `CFRunLoopRemoveSource`,
//! * then releases the wrapper retains.
//!
//! Without that, the previous version of `Drop` only released our
//! retains while the run loop kept its own — the tap would silently
//! continue firing. See `zen_dictation::hotkey::macos::TapHandle`'s
//! `Drop` impl for the corrected teardown.
//!
//! [`stop`] also hides the mic tray (in case the user toggles off
//! mid-recording) and resets the manager's recording flag to a sane
//! `false`.
//!
//! Idempotent — calling [`start`] when already running, or [`stop`]
//! when already off, is a no-op.

use tauri::{AppHandle, Emitter, Manager};

use super::permissions::is_accessibility_trusted;
use super::state::DictationTauriState;
use super::{ensure_model_present, hud, install_hotkey};
use crate::tray;
use zen_dictation::ModelId;

/// Light up the dictation pipeline. Idempotent: if a hotkey handle is
/// already installed we leave it alone and only re-trigger the base
/// model precheck.
pub fn start(app: &AppHandle) {
    let dictation_state = match app.try_state::<DictationTauriState>() {
        Some(s) => s.inner().clone(),
        None => {
            tracing::warn!("dictation: state not registered; skipping start");
            return;
        }
    };

    // Background base-model precheck — same flow `bootstrap` used to
    // run inline. Cheap when the file already exists.
    {
        let app_for_download = app.clone();
        let state_for_download = dictation_state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) =
                ensure_model_present(&app_for_download, &state_for_download, ModelId::Base).await
            {
                tracing::warn!(?e, "dictation: base model precheck failed");
            }
        });
    }

    // Pre-check Accessibility (TCC) before touching the CGEventTap.
    // macOS keys TCC by bundle id; the recent rename
    // (`com.zen-tools.app` → `com.seg4lt.zen-tools`) invalidated any
    // prior grant, so the very first call to `CGEventTapCreate` after
    // the rename pops the system "Zen Tools would like to control
    // this computer using accessibility features" dialog. With the
    // tap install running on every boot, that dialog reappears every
    // launch until the user grants — terrible UX.
    //
    // Skipping the install when not trusted means the boot is
    // dialog-free; the tray + Settings UI can show a soft prompt
    // pointing the user to System Settings → Privacy & Security →
    // Accessibility. Once granted, a relaunch (or a future
    // "retry install" command) picks up where this left off.
    if !is_accessibility_trusted() {
        tracing::warn!(
            "dictation: Accessibility permission not granted for the current \
             bundle id (com.seg4lt.zen-tools). Skipping CGEventTap install — \
             the right-⌘ hotkey will not work until the user grants \
             Accessibility in System Settings → Privacy & Security and \
             relaunches. The model precheck still runs."
        );
        let _ = app.emit("dictation:lifecycle", "accessibility-required");
        let _ = app.emit("dictation:status", "needs-accessibility");
        // Still update the tray so the menu reflects the current
        // (degraded) state instead of staying stale.
        tray::update(app);
        return;
    }

    // CGEventTap install must happen on the Cocoa main thread.
    // Idempotent — `install_hotkey` overwrites any previous handle on
    // the manager, so a stop→start cycle correctly tears down the
    // old tap (via its Drop impl) and registers a fresh one.
    let app_for_main = app.clone();
    let state_for_main = dictation_state;
    let _ = app.run_on_main_thread(move || {
        // If the manager already has a hotkey handle, drop it first
        // so we don't leak a tap. `set_hotkey_handle(None)` swaps
        // the option, the old handle drops, its Drop impl runs and
        // detaches the previous CGEventTap from the run loop.
        state_for_main.manager.set_hotkey_handle(None);
        install_hotkey(&app_for_main, &state_for_main);
        tracing::info!("dictation: lifecycle started");
    });

    // Repaint the unified Zen Tools tray so the "Disable dictation"
    // menu item flips from disabled to enabled.
    tray::update(app);

    let _ = app.emit("dictation:lifecycle", "started");
}

/// Tear the dictation pipeline down. After this returns nothing about
/// dictation is observable: no CGEventTap, no mic tray, no
/// recording-in-progress flag.
pub fn stop(app: &AppHandle) {
    let dictation_state = match app.try_state::<DictationTauriState>() {
        Some(s) => s.inner().clone(),
        None => return,
    };

    // 1. Drop the hotkey handle on the main thread. The Drop impl on
    //    `TapHandle` removes the run-loop source and disables the
    //    tap before the wrapper types release their retains —
    //    without this the tap would keep firing in the background.
    let state_for_main = dictation_state.clone();
    let _ = app.run_on_main_thread(move || {
        state_for_main.manager.set_hotkey_handle(None);
        tracing::info!("dictation: hotkey watcher uninstalled");
    });

    // 2. Hide the mic tray in case it was visible (e.g. the user
    //    toggled off while a recording was in flight). `set_state`
    //    is itself dispatched on main and idempotent.
    hud::set_state(app, hud::HudState::Hidden);

    // 3. If a recording was actively in progress, abandon it. We
    //    can't gracefully cancel an in-flight whisper inference
    //    that's already running on a worker, but stopping the
    //    capture and resetting the state machine prevents a
    //    surprise paste landing after the user has disabled the
    //    tool.
    dictation_state.manager.abandon_recording();

    // 4. Repaint the unified tray so "Disable dictation" greys out.
    tray::update(app);

    let _ = app.emit("dictation:lifecycle", "stopped");
    let _ = app.emit("dictation:status", "idle");
}
