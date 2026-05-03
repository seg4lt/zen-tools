//! Tauri command surface for the Process Monitor tool.
//!
//! State lives inside the existing [`AppState`](crate::state::AppState)
//! (`pm_state` field, a [`zen_process_monitor::SharedState`]). The blocking
//! sampler thread is spawned once in `lib.rs::run`'s `setup` closure;
//! these commands only manipulate the shared state and re-emit the tray
//! visibility update.
//!
//! Every mutating command calls `crate::tray::update_tray(&app)` after
//! the lock is released, so the macOS menu-bar icon appears the instant
//! the user picks a PID and disappears when they clear the selection
//! (provided no perf test is also running).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::tray;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;
use ts_rs::TS;
use zen_process_monitor::{ProcSummary, Sample};

/// Snapshot of the current process-monitor configuration (for re-hydration
/// on tool mount).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PmConfig {
    /// Polling interval in milliseconds.
    pub poll_ms: u32,
    /// Currently-monitored root PIDs.
    pub target_pids: Vec<i32>,
}

/// One-shot snapshot of every PID the caller can see (sorted alphabetically).
#[tauri::command]
pub async fn pm_list_processes() -> AppResult<Vec<ProcSummary>> {
    zen_process_monitor::list_processes()
        .map_err(|e| AppError::Other(format!("list_processes: {e}")))
}

/// Add a single PID to the monitored set.
#[tauri::command]
pub async fn pm_add_target(
    pid: i32,
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    {
        let s = state.lock().await;
        s.pm_state.lock().add_target(pid);
    }
    let _ = tray::update_tray(&app);
    Ok(())
}

/// Remove one PID from the monitored set.
#[tauri::command]
pub async fn pm_remove_target(
    pid: i32,
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    {
        let s = state.lock().await;
        s.pm_state.lock().remove_target(pid);
    }
    let _ = tray::update_tray(&app);
    Ok(())
}

/// Replace the monitored set wholesale.
#[tauri::command]
pub async fn pm_set_targets(
    pids: Vec<i32>,
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    {
        let s = state.lock().await;
        s.pm_state.lock().set_targets(pids);
    }
    let _ = tray::update_tray(&app);
    Ok(())
}

/// Stop monitoring everything.
#[tauri::command]
pub async fn pm_clear_targets(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    {
        let s = state.lock().await;
        s.pm_state.lock().clear_targets();
    }
    let _ = tray::update_tray(&app);
    Ok(())
}

/// Read the current config (poll interval + target PIDs).
#[tauri::command]
pub async fn pm_get_config(state: State<'_, Mutex<AppState>>) -> AppResult<PmConfig> {
    let s = state.lock().await;
    let pm = s.pm_state.lock();
    Ok(PmConfig {
        poll_ms: pm.poll_interval_ms,
        target_pids: pm.target_pids.clone(),
    })
}

/// Read the rolling sample history (used to repaint sparklines after a
/// component remount or window switch).
#[tauri::command]
pub async fn pm_get_history(state: State<'_, Mutex<AppState>>) -> AppResult<Vec<Sample>> {
    let s = state.lock().await;
    let pm = s.pm_state.lock();
    Ok(pm.history.iter().cloned().collect())
}

/// Update the polling interval (clamped to `[100, 60_000]` ms by the sampler).
#[tauri::command]
pub async fn pm_set_poll_interval(
    poll_ms: u32,
    state: State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let s = state.lock().await;
    s.pm_state.lock().set_poll_interval(poll_ms);
    Ok(())
}

/// Hide the tray popover window. Used by the popover's "Open Full
/// Window" button so the popover dismisses as the main window comes
/// forward.
#[tauri::command]
pub async fn pm_popover_close(app: AppHandle) -> AppResult<()> {
    tray::destroy_popover(&app);
    Ok(())
}

/// Bring the main window to the foreground (and unminimise if needed).
/// Used by the popover's "Open Full Window" button.
#[tauri::command]
pub async fn pm_show_main_window(app: AppHandle) -> AppResult<()> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    tray::destroy_popover(&app);
    Ok(())
}
