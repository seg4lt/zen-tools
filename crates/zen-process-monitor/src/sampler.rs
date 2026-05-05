//! Sampling thread: periodically reads the monitored process trees, computes
//! deltas, and pushes a [`Sample`] to history + a `tokio::sync::broadcast`
//! channel for downstream consumers (the Tauri command layer subscribes and
//! re-emits as a `pm:sample` Tauri event).
//!
//! The sampler tracks a list of root PIDs, each independently rooted in
//! the process table. On every tick:
//!   1. Walk each root's tree (BFS) capturing `(pid, depth, root_pid)`.
//!   2. Deduplicate (a process can be a descendant of two roots
//!      simultaneously — first occurrence wins).
//!   3. Read raw stats once per unique PID.
//!   4. Diff against previous tick to compute CPU%.
//!   5. Sum across all PIDs for the aggregate `total`, push a `Sample` to
//!      history, and broadcast it.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::proc::{PidSample, PidStats};

/// Number of samples retained in the rolling history (240 × 1 s = 4 min).
pub const HISTORY_LEN: usize = 240;
const MIN_POLL_MS: u32 = 100;
const MAX_POLL_MS: u32 = 60_000;
/// Default polling interval in milliseconds (1 s).
pub const DEFAULT_POLL_MS: u32 = 1000;

/// One full snapshot emitted to the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Sample {
    /// Unix epoch milliseconds.
    #[ts(type = "number")]
    pub ts: u64,
    /// Aggregate values summed across every monitored tree.
    pub total: TotalStats,
    /// Per-PID rows, ordered by tree (root first, then DFS into children).
    pub per_pid: Vec<PidStats>,
    /// PIDs that are configured as roots but no longer exist on the system.
    pub ended_roots: Vec<i32>,
}

/// Aggregate values summed across every monitored tree (target rows only —
/// ancestor rows are excluded).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TotalStats {
    /// Total CPU% across all monitored target subtrees.
    pub cpu_pct: f64,
    /// Total resident set size.
    #[ts(type = "number")]
    pub rss: u64,
    /// Total virtual size.
    #[ts(type = "number")]
    pub vsize: u64,
    /// Total Activity-Monitor "Memory" (phys footprint).
    #[ts(type = "number")]
    pub phys_footprint: u64,
    /// Number of processes contributing to the totals.
    #[ts(type = "number")]
    pub proc_count: usize,
    /// Number of root targets whose process is still alive.
    #[ts(type = "number")]
    pub root_count: usize,
    /// Total thread count summed across every monitored target
    /// subtree. Useful for spotting cumulative thread sprawl across
    /// a multi-root selection.
    pub threads: u32,
}

/// State shared between commands and the sampler thread.
pub struct SamplerState {
    /// User-selected root PIDs to monitor.
    pub target_pids: Vec<i32>,
    /// Polling interval in milliseconds, clamped to `[MIN_POLL_MS, MAX_POLL_MS]`.
    pub poll_interval_ms: u32,
    /// Last sample for each PID, used to compute deltas.
    #[cfg(target_os = "macos")]
    prev_per_pid: std::collections::HashMap<i32, PidSample>,
    /// Wall-clock instant of the last sample. CPU% denominator.
    #[cfg(target_os = "macos")]
    prev_wall: Option<std::time::Instant>,
    /// Rolling history buffer (capacity = `HISTORY_LEN`).
    pub history: VecDeque<Sample>,
}

impl SamplerState {
    /// Empty state: no targets, default 1 s poll, empty history.
    pub fn new() -> Self {
        Self {
            target_pids: Vec::new(),
            poll_interval_ms: DEFAULT_POLL_MS,
            #[cfg(target_os = "macos")]
            prev_per_pid: std::collections::HashMap::new(),
            #[cfg(target_os = "macos")]
            prev_wall: None,
            history: VecDeque::with_capacity(HISTORY_LEN),
        }
    }

    /// Add a PID to the target list (no-op if already present).
    pub fn add_target(&mut self, pid: i32) {
        if !self.target_pids.contains(&pid) {
            self.target_pids.push(pid);
        }
        self.reset_deltas();
    }

    /// Drop a PID from the target list.
    pub fn remove_target(&mut self, pid: i32) {
        self.target_pids.retain(|&p| p != pid);
        self.reset_deltas();
    }

    /// Replace the target list wholesale.
    pub fn set_targets(&mut self, pids: Vec<i32>) {
        self.target_pids = pids;
        self.reset_deltas();
    }

    /// Stop monitoring everything.
    pub fn clear_targets(&mut self) {
        self.target_pids.clear();
        self.reset_deltas();
    }

    /// True when the sampler should be doing work this tick.
    pub fn is_active(&self) -> bool {
        !self.target_pids.is_empty()
    }

    fn reset_deltas(&mut self) {
        // After any target change, drop deltas — first sample is baseline.
        #[cfg(target_os = "macos")]
        {
            self.prev_per_pid.clear();
            self.prev_wall = None;
        }
        self.history.clear();
    }

    /// Update the polling interval, clamped to a sane range.
    pub fn set_poll_interval(&mut self, ms: u32) {
        self.poll_interval_ms = ms.clamp(MIN_POLL_MS, MAX_POLL_MS);
    }
}

impl Default for SamplerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience alias: shared, mutex-guarded sampler state.
pub type SharedState = Arc<Mutex<SamplerState>>;

/// Handle returned by [`run_sampler`] — currently only used to subscribe to
/// the sample broadcast channel from the Tauri command layer.
#[derive(Clone)]
pub struct SamplerHandle {
    /// Broadcast sender. Subscribe via [`SamplerHandle::subscribe`].
    pub tx: broadcast::Sender<Sample>,
}

impl SamplerHandle {
    /// Subscribe to the live sample stream.
    pub fn subscribe(&self) -> broadcast::Receiver<Sample> {
        self.tx.subscribe()
    }
}

/// Blocking loop that owns the sampler. Spawn on a dedicated thread or
/// `tokio::task::spawn_blocking`. Runs until process exit.
pub fn run_sampler(state: SharedState, tx: broadcast::Sender<Sample>) {
    loop {
        let started = std::time::Instant::now();
        let (targets, interval_ms) = {
            let s = state.lock();
            (s.target_pids.clone(), s.poll_interval_ms)
        };

        if !targets.is_empty() {
            let sample = collect_sample(&targets, &state);
            {
                let mut s = state.lock();
                if s.history.len() >= HISTORY_LEN {
                    s.history.pop_front();
                }
                s.history.push_back(sample.clone());
            }
            // `send` only fails if there are no subscribers — that's fine,
            // the next subscriber catches up via `pm_get_history`.
            let _ = tx.send(sample);
        }

        let elapsed = started.elapsed();
        let interval = Duration::from_millis(u64::from(interval_ms));
        if elapsed < interval {
            std::thread::sleep(interval - elapsed);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
struct TreeEntry {
    pid: i32,
    depth: u32,
    root_pid: i32,
    is_ancestor: bool,
}

#[cfg(target_os = "macos")]
fn collect_sample(roots: &[i32], state: &SharedState) -> Sample {
    use crate::proc::{cpu, stats, tree};
    use std::collections::{HashMap, HashSet};

    // 1. Snapshot the process table once; reuse for every tree walk.
    let all = match tree::list_all() {
        Ok(v) => v,
        Err(_) => {
            return Sample {
                ts: now_ms(),
                ended_roots: roots.to_vec(),
                ..Default::default()
            }
        }
    };

    // 2. For each root: ancestor chain (root-most first), then target +
    //    descendants in DFS order. Dedupe across roots; first claim wins.
    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut seen: HashSet<i32> = HashSet::new();
    let mut ended_roots: Vec<i32> = Vec::new();

    for &root in roots {
        let walk = tree::descendants_of(root, &all);
        if walk.is_empty() {
            ended_roots.push(root);
            continue;
        }

        let mut ancestors = tree::ancestors_of(root, &all);
        ancestors.reverse();
        let max_distance = ancestors.len() as u32;
        for (idx, anc) in ancestors.into_iter().enumerate() {
            let distance = max_distance - idx as u32;
            if seen.insert(anc.pid) {
                entries.push(TreeEntry {
                    pid: anc.pid,
                    depth: distance,
                    root_pid: root,
                    is_ancestor: true,
                });
            }
        }

        for (proc_info, depth) in walk {
            if seen.insert(proc_info.pid) {
                entries.push(TreeEntry {
                    pid: proc_info.pid,
                    depth,
                    root_pid: root,
                    is_ancestor: false,
                });
            }
        }
    }

    // 3. Wall-clock instant for the CPU% denominator.
    let now_instant = std::time::Instant::now();

    // 4. Read per-PID stats.
    let mut current: HashMap<i32, PidSample> = HashMap::with_capacity(entries.len());
    for e in &entries {
        if let Some(s) = stats::read(e.pid) {
            current.insert(e.pid, s);
        }
    }

    // 5. Compute deltas using previous sample.
    let mut s = state.lock();
    let d_wall_ns: u64 = s
        .prev_wall
        .map(|prev| now_instant.duration_since(prev).as_nanos() as u64)
        .unwrap_or(0);

    let mut per_pid: Vec<PidStats> = Vec::with_capacity(entries.len());
    let mut total = TotalStats {
        proc_count: 0,
        root_count: roots.len() - ended_roots.len(),
        ..Default::default()
    };

    for entry in &entries {
        let Some(sample) = current.get(&entry.pid) else {
            continue;
        };
        let prev = s.prev_per_pid.get(&entry.pid);
        let d_proc_ticks = match prev {
            Some(p) => sample.cpu_ticks.saturating_sub(p.cpu_ticks),
            None => 0,
        };
        let cpu_pct = if d_wall_ns > 0 && prev.is_some() {
            cpu::cpu_pct(d_proc_ticks, d_wall_ns)
        } else {
            0.0
        };

        per_pid.push(PidStats {
            pid: entry.pid,
            ppid: sample.ppid,
            pgid: sample.pgid,
            name: sample.name.clone(),
            root_pid: entry.root_pid,
            depth: entry.depth,
            is_ancestor: entry.is_ancestor,
            cpu_pct,
            rss: sample.rss,
            vsize: sample.vsize,
            phys_footprint: sample.phys_footprint,
            threads: sample.threads,
        });

        if !entry.is_ancestor {
            total.cpu_pct += cpu_pct;
            total.rss = total.rss.saturating_add(sample.rss);
            total.vsize = total.vsize.saturating_add(sample.vsize);
            total.phys_footprint = total.phys_footprint.saturating_add(sample.phys_footprint);
            total.proc_count += 1;
            total.threads = total.threads.saturating_add(sample.threads);
        }
    }

    s.prev_per_pid = current;
    s.prev_wall = Some(now_instant);

    Sample {
        ts: now_ms(),
        total,
        per_pid,
        ended_roots,
    }
}

#[cfg(not(target_os = "macos"))]
fn collect_sample(roots: &[i32], _state: &SharedState) -> Sample {
    // Non-macOS targets: emit empty samples so the surrounding workspace
    // still builds. The frontend will simply show "Awaiting first sample…"
    Sample {
        ts: now_ms(),
        ended_roots: roots.to_vec(),
        ..Default::default()
    }
}
