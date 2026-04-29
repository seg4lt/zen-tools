//! Process-tree sampler used by the Zen Tools "Process Monitor" tool.
//!
//! This crate is a stand-alone library — it does **not** depend on Tauri.
//! The Tauri command layer in `src-tauri/src/commands/process_monitor.rs`
//! holds a [`SamplerState`] inside the existing `AppState` and forwards
//! samples to the React frontend via a `tokio::sync::broadcast` channel.
//!
//! ## Platform support
//!
//! Sampling uses macOS-only `libproc` syscalls plus the
//! `responsibility_get_pid_responsible_for_pid` libsystem export. On any
//! other target (Linux CI, Windows builds), every entry point returns
//! [`Error::NotSupported`] so the surrounding workspace still compiles.
//!
//! ## Public surface
//!
//! - [`SamplerState`] — shared state between the sampler thread and
//!   command handlers (target PID list, history ring, poll interval).
//! - [`Sample`], [`TotalStats`], [`PidStats`], [`PidSample`] — the
//!   data types streamed to the UI.
//! - [`run_sampler`] — blocking function that owns the polling loop.
//!   Spawn it on a dedicated thread (or `tokio::task::spawn_blocking`).
//! - [`list_processes`] — one-shot snapshot of every PID, used by the
//!   picker.

#![warn(missing_docs)]

pub mod proc;
pub mod sampler;

pub use proc::{PidSample, PidStats, ProcSummary};
pub use sampler::{
    run_sampler, Sample, SamplerHandle, SamplerState, SharedState, TotalStats, DEFAULT_POLL_MS,
    HISTORY_LEN,
};

/// Errors surfaced from this crate. Only [`Error::NotSupported`] is
/// returned today — every macOS sampling failure is logged via `tracing`
/// and resolves to an empty/zeroed sample so the UI never goes blank.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Returned by [`list_processes`] when built for a non-macOS target.
    #[error("process monitoring is only supported on macOS")]
    NotSupported,
    /// Surfaced when the underlying `libproc` call fails on macOS.
    #[error("libproc error: {0}")]
    LibProc(String),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, Error>;

/// One-shot snapshot of every PID the caller can see, sorted by lowercase
/// name (matches the ordering process-monitor's picker.rs expects).
///
/// On non-macOS targets this returns [`Error::NotSupported`].
pub fn list_processes() -> Result<Vec<ProcSummary>> {
    #[cfg(target_os = "macos")]
    {
        let infos = proc::tree::list_all().map_err(Error::LibProc)?;
        let mut out: Vec<ProcSummary> = infos
            .into_iter()
            .map(|p| ProcSummary {
                pid: p.pid,
                ppid: p.ppid,
                name: p.name,
            })
            .collect();
        out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
        Ok(out)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::NotSupported)
    }
}
