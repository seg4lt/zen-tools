//! Process introspection: tree walking, per-PID stats, CPU% denominator.
//!
//! All of this is macOS-specific. Submodules are gated with
//! `#[cfg(target_os = "macos")]`; on other platforms only the data types
//! are exposed (so the broader workspace still compiles for Linux CI).

#[cfg(target_os = "macos")]
pub mod cpu;
#[cfg(target_os = "macos")]
pub mod stats;
#[cfg(target_os = "macos")]
pub mod tree;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Lightweight process descriptor used by the picker UI.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProcSummary {
    /// Process id.
    pub pid: i32,
    /// Parent process id.
    pub ppid: i32,
    /// Executable name (`pbi_name`, falling back to `pbi_comm`).
    pub name: String,
}

/// One row of per-PID stats, raw counters (not deltas, not percentages).
///
/// `u64` fields override the ts-rs default of `bigint` to plain
/// `number` because the JSON wire (Tauri's IPC) serialises `u64` as a
/// JSON number, not a string. JS `number` is f64 so the only practical
/// risk is byte counts ≥ 2^53 (≈ 9 PB) — not a real concern for RSS.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PidSample {
    /// Process id.
    pub pid: i32,
    /// Parent process id.
    pub ppid: i32,
    /// POSIX process group leader pid.
    pub pgid: i32,
    /// Executable name.
    pub name: String,
    /// Sum of user+system CPU ticks (proc_taskinfo.pti_total_user + pti_total_system).
    #[ts(type = "number")]
    pub cpu_ticks: u64,
    /// Resident Set Size in bytes (proc_taskinfo.pti_resident_size).
    #[ts(type = "number")]
    pub rss: u64,
    /// Virtual size in bytes (proc_taskinfo.pti_virtual_size).
    #[ts(type = "number")]
    pub vsize: u64,
    /// Phys footprint in bytes (rusage_info_v6.ri_phys_footprint) — what
    /// Activity Monitor calls "Memory".
    #[ts(type = "number")]
    pub phys_footprint: u64,
}

/// Computed delta values for one PID over a sampling interval.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PidStats {
    /// Process id.
    pub pid: i32,
    /// Parent process id.
    pub ppid: i32,
    /// Process group leader's PID. Useful for the UI to indicate when a
    /// row is hierarchically attached via PGID rather than PPID (e.g.
    /// when ppid was severed by a detach-style spawn).
    pub pgid: i32,
    /// Executable name.
    pub name: String,
    /// Which monitored root this PID is associated with. For ancestors and
    /// descendants alike, this is the user-selected target.
    pub root_pid: i32,
    /// For descendants: depth from the root (0 = root, 1 = child, …).
    /// For ancestors: distance going *up* from the root (1 = parent, 2 = grandparent, …).
    pub depth: u32,
    /// True if this row is an ancestor (parent/grandparent/…) of `root_pid`,
    /// shown for context only. Ancestor rows are NOT summed into totals.
    pub is_ancestor: bool,
    /// CPU% where 100% = one core fully utilised.
    pub cpu_pct: f64,
    /// Resident set size in bytes.
    #[ts(type = "number")]
    pub rss: u64,
    /// Virtual size in bytes.
    #[ts(type = "number")]
    pub vsize: u64,
    /// Phys footprint (Activity Monitor "Memory") in bytes.
    #[ts(type = "number")]
    pub phys_footprint: u64,
}
