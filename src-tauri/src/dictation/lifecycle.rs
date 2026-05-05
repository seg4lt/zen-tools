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

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::install_id::{
    self, decide_autofix, AutoFixDecision,
};
use super::permissions::{
    is_accessibility_trusted, is_running_inside_app_bundle,
    microphone_authorization_status, prompt_accessibility, request_microphone_access,
    reset_tcc_entry, MicAuthStatus,
};
use super::state::DictationTauriState;
use super::{ensure_model_present, hud, install_hotkey};
use crate::tray;
use crate::user_config::UserConfig;
use zen_dictation::ModelId;

/// Maximum window we poll `AXIsProcessTrusted()` for after firing the
/// system Accessibility prompt. macOS caches the trust state in the
/// running process — even after the user clicks Allow, the same
/// process may keep returning `false` for a few seconds. We poll at
/// 1 Hz; this caps the worst case before we give up and let the user
/// fall back to the manual UI.
const AX_POLL_TIMEOUT: Duration = Duration::from_secs(30);
const AX_POLL_INTERVAL: Duration = Duration::from_secs(1);

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
    // The auto-fix flow handles three scenarios:
    //
    //   * Already trusted → install the tap directly, persist the
    //     observation so future deliberate denials are recognised.
    //   * Not trusted, no prior record (or new install) → fire the
    //     system prompt; if a stale entry is blocking it, run
    //     `tccutil reset` first so the prompt actually appears.
    //   * Not trusted, same install as a prior grant → the user
    //     deliberately revoked; surface the banner, do NOT auto-reset.
    //
    // The matrix is in `install_id::decide_autofix` (pure logic,
    // unit-tested). This block just wires the side-effects.
    handle_accessibility_precheck(app);

    // Microphone has a richer authorization-status API; precheck it
    // in parallel with accessibility. No CGEventTap dependency, but
    // the recording pipeline can't fire without it, so we want the
    // user prompted at the same moment they enable dictation rather
    // than discovering it's broken on first long-press.
    handle_microphone_precheck(app);

    // CGEventTap install must happen on the Cocoa main thread, but
    // ONLY if accessibility is trusted RIGHT NOW. The precheck above
    // may have kicked off a prompt; if so, the tap install is
    // deferred to the post-prompt poll loop, which calls
    // `install_tap_now` once `AXIsProcessTrusted()` flips true.
    if is_accessibility_trusted() {
        install_tap_now(app);
        let _ = app.emit("dictation:lifecycle", "started");
    } else {
        // Repaint the tray so the menu reflects the degraded state
        // until the prompt is answered.
        tray::update(app);
        let _ = app.emit("dictation:lifecycle", "accessibility-required");
        let _ = app.emit("dictation:status", "needs-accessibility");
    }
}

/// Install (or reinstall) the CGEventTap on the Cocoa main thread.
/// Idempotent — `install_hotkey` overwrites any previous handle on
/// the manager, so a stop→start cycle correctly tears down the old
/// tap (via its Drop impl) and registers a fresh one. Pulled out of
/// `start` so the post-prompt poll can call it once Accessibility
/// flips trusted without duplicating the main-thread dance.
fn install_tap_now(app: &AppHandle) {
    let dictation_state = match app.try_state::<DictationTauriState>() {
        Some(s) => s.inner().clone(),
        None => return,
    };

    let app_for_main = app.clone();
    let state_for_main = dictation_state;
    let _ = app.run_on_main_thread(move || {
        state_for_main.manager.set_hotkey_handle(None);
        install_hotkey(&app_for_main, &state_for_main);
        tracing::info!("dictation: hotkey watcher installed");
    });

    tray::update(app);
}

/// Implements the accessibility decision matrix. See module docs for
/// the matrix; this fn is just the side-effect dispatcher.
///
/// **Dev-build guard.** Any branch that fires `prompt_accessibility()`
/// or `tccutil reset` is gated on `is_running_inside_app_bundle()`.
/// In `cargo tauri dev` the running executable lives at
/// `target/debug/zen-tools` with no surrounding `.app` bundle, so
/// macOS reads no `Info.plist` and any TCC-prompting call would be
/// terminated by `__abort_with_payload(TCC_VIOLATION)` — the process
/// just exits, no panic, no log. We surface the same
/// `accessibility-required` event so the React UI's manual buttons
/// still let the user trigger the prompt explicitly (the prompt
/// itself works via cpal/CoreAudio's separate enforcement path,
/// it's only the direct `AVCaptureDevice` / `AXIsProcessTrustedWithOptions`
/// FFI that's lethal in the unbundled case).
fn handle_accessibility_precheck(app: &AppHandle) {
    let granted = is_accessibility_trusted();
    let cfg_handle = app.state::<UserConfig>();
    let cfg = cfg_handle.inner();

    let current = install_id::current(app);
    let prior = install_id::read(cfg)
        .ok()
        .flatten()
        .and_then(|p| p.accessibility);
    let decision = decide_autofix(granted, &current, prior.as_ref());
    let bundled = is_running_inside_app_bundle();

    tracing::info!(
        ?decision,
        bundled,
        version = %current.version,
        "dictation: accessibility precheck"
    );

    match decision {
        AutoFixDecision::AlreadyGranted => {
            if let Err(e) = install_id::record_accessibility_grant(cfg, current.clone()) {
                tracing::warn!(?e, "dictation: failed to persist AX grant record");
            }
        }
        AutoFixDecision::PromptFresh => {
            if bundled {
                let _ = prompt_accessibility();
                spawn_accessibility_poll(app);
            } else {
                tracing::info!(
                    "dictation: skipping auto-prompt for Accessibility — \
                     running outside an .app bundle (cargo tauri dev). \
                     Use the manual button in Settings to trigger the prompt."
                );
            }
        }
        AutoFixDecision::ResetThenPrompt => {
            if bundled {
                let bundle_id = app.config().identifier.clone();
                tracing::info!(
                    %bundle_id,
                    "dictation: stale Accessibility TCC entry detected; resetting and re-prompting"
                );
                if let Err(e) = reset_tcc_entry("Accessibility", &bundle_id) {
                    tracing::warn!(?e, "dictation: tccutil reset Accessibility failed; falling back to manual UI");
                }
                let _ = prompt_accessibility();
                spawn_accessibility_poll(app);
            } else {
                tracing::info!(
                    "dictation: skipping auto-reset for Accessibility — \
                     running outside an .app bundle (cargo tauri dev)."
                );
            }
        }
        AutoFixDecision::DeliberateDenial => {
            tracing::info!(
                "dictation: Accessibility denied on a binary that previously had it granted; \
                 treating as deliberate revocation, leaving TCC entry alone"
            );
        }
        AutoFixDecision::Unknown => {
            tracing::warn!(
                "dictation: could not determine current install id; surfacing manual UI without auto-reset"
            );
        }
    }
}

/// Poll `AXIsProcessTrusted()` for up to [`AX_POLL_TIMEOUT`] after
/// firing the system prompt. The first `true` reading installs the
/// tap and persists the grant record. Times out silently if the user
/// dismisses the prompt or the dialog never reaches the foreground.
///
/// The poll is best-effort: if `lifecycle::stop` runs (user toggles
/// off), the spawned task observes the missing `DictationTauriState`
/// on its next iteration and exits — there is no zombie loop.
fn spawn_accessibility_poll(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + AX_POLL_TIMEOUT;
        loop {
            tokio::time::sleep(AX_POLL_INTERVAL).await;
            if std::time::Instant::now() > deadline {
                tracing::info!(
                    "dictation: accessibility poll timed out; manual UI takes over"
                );
                return;
            }
            // If the user disabled dictation while we were waiting,
            // bail out — `stop()` will have already cleared the tray
            // and the manager.
            if app.try_state::<DictationTauriState>().is_none() {
                return;
            }
            if is_accessibility_trusted() {
                tracing::info!("dictation: Accessibility granted; installing CGEventTap");
                if let Some(cfg) = app.try_state::<UserConfig>() {
                    let id = install_id::current(&app);
                    if let Err(e) =
                        install_id::record_accessibility_grant(cfg.inner(), id)
                    {
                        tracing::warn!(?e, "dictation: persist AX grant failed");
                    }
                }
                install_tap_now(&app);
                let _ = app.emit("dictation:lifecycle", "started");
                let _ = app.emit("dictation:status", "idle");
                return;
            }
        }
    });
}

/// Implements the microphone decision matrix. Mirrors the
/// accessibility flow but uses `AVCaptureDevice.authorizationStatus`
/// (richer state) so we don't need the install-id heuristic to
/// distinguish "no prior entry" from "denied" — `notDetermined` and
/// `denied` are separate enum values.
///
/// **Dev-build guard, critical here.** `AVCaptureDevice.requestAccess
/// ForMediaType:` requires `NSMicrophoneUsageDescription` in the
/// running process's `Info.plist`. When `cargo tauri dev` runs the
/// raw binary at `target/debug/zen-tools` there is no Info.plist in
/// scope, and macOS terminates the process with
/// `__abort_with_payload(TCC_VIOLATION)` — no exception, no panic,
/// no log line. The first build of this auto-fix flow shipped
/// without the guard and the dev binary died silently right after
/// the precheck log line. The bundled `.app` build has Info.plist
/// in the right place and the prompt fires normally.
fn handle_microphone_precheck(app: &AppHandle) {
    let status = microphone_authorization_status();
    let cfg_handle = app.state::<UserConfig>();
    let cfg = cfg_handle.inner();
    let current = install_id::current(app);
    let bundled = is_running_inside_app_bundle();

    tracing::info!(?status, bundled, "dictation: microphone precheck");

    match status {
        MicAuthStatus::Authorized => {
            if let Err(e) = install_id::record_microphone_grant(cfg, current) {
                tracing::warn!(?e, "dictation: failed to persist mic grant record");
            }
        }
        MicAuthStatus::NotDetermined => {
            if bundled {
                // No entry exists yet; `requestAccess` will prompt
                // directly, no `tccutil reset` needed.
                spawn_microphone_request(app, false);
            } else {
                tracing::info!(
                    "dictation: skipping auto-prompt for Microphone — \
                     running outside an .app bundle (cargo tauri dev) where \
                     AVCaptureDevice.requestAccess would terminate the process. \
                     The system mic prompt will fire on first recording attempt \
                     via cpal/CoreAudio, which uses a different enforcement path."
                );
            }
        }
        MicAuthStatus::Denied => {
            let prior = install_id::read(cfg)
                .ok()
                .flatten()
                .and_then(|p| p.microphone);
            let decision = decide_autofix(false, &current, prior.as_ref());
            match decision {
                AutoFixDecision::ResetThenPrompt => {
                    if bundled {
                        let bundle_id = app.config().identifier.clone();
                        tracing::info!(
                            %bundle_id,
                            "dictation: stale Microphone TCC entry detected; resetting and re-prompting"
                        );
                        if let Err(e) = reset_tcc_entry("Microphone", &bundle_id) {
                            tracing::warn!(
                                ?e,
                                "dictation: tccutil reset Microphone failed; falling back to manual UI"
                            );
                        }
                        spawn_microphone_request(app, true);
                    } else {
                        tracing::info!(
                            "dictation: skipping auto-reset for Microphone — \
                             running outside an .app bundle (cargo tauri dev)."
                        );
                    }
                }
                AutoFixDecision::DeliberateDenial => {
                    tracing::info!(
                        "dictation: Microphone denied on the same install that previously had it; \
                         treating as deliberate, leaving TCC entry alone"
                    );
                }
                _ => {
                    // PromptFresh / Unknown / AlreadyGranted are
                    // unreachable when status == Denied (Denied
                    // implies an entry exists, so the install-id
                    // heuristic above must produce one of the two
                    // matched arms). If we somehow get here, fall
                    // through to the manual UI.
                }
            }
        }
        MicAuthStatus::Restricted => {
            tracing::warn!(
                "dictation: Microphone access is restricted (managed by configuration profile); \
                 dictation cannot be enabled on this device"
            );
        }
    }
}

/// Fire `AVCaptureDevice.requestAccess(for: .audio)`. Persists the
/// grant on success so future revocations are recognised as
/// deliberate.
///
/// `from_reset` is purely diagnostic — included in the log line so
/// when reading the trace it's obvious whether the prompt followed a
/// fresh first-run or a heuristic-driven `tccutil reset`.
fn spawn_microphone_request(app: &AppHandle, from_reset: bool) {
    let app = app.clone();
    request_microphone_access(move |granted| {
        tracing::info!(
            granted,
            from_reset,
            "dictation: microphone permission completion"
        );
        if granted {
            if let Some(cfg) = app.try_state::<UserConfig>() {
                let id = install_id::current(&app);
                if let Err(e) = install_id::record_microphone_grant(cfg.inner(), id) {
                    tracing::warn!(?e, "dictation: persist mic grant failed");
                }
            }
        }
        // Repaint UI so the warning banner clears the moment the
        // user clicks Allow, without waiting for a window-focus
        // refresh.
        let _ = app.emit("dictation:permissions-changed", granted);
    });
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
