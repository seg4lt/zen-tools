//! Per-process CPU% calculation, Activity-Monitor-accurate.
//!
//! ## The unit gotcha
//!
//! `proc_taskinfo.pti_total_user` and `pti_total_system` are reported in
//! **MachAbsoluteTime units** — ticks of the high-resolution constant-rate
//! timer. On Apple Silicon the timebase is typically `numer = 125,
//! denom = 3` so 1 tick ≈ 41.67 ns; on Intel it's 1 tick = 1 ns. To get
//! nanoseconds you must multiply by `mach_timebase_info.numer / denom`.
//!
//! ## Correct formula
//!
//!   d_proc_ns = (d_proc_ticks * timebase.numer) / timebase.denom
//!   cpu_pct   = (d_proc_ns / d_wall_ns) * 100.0
//!
//! 100% = one core fully utilised. 800% on an 8-core box = pegging every
//! core. Matches Activity Monitor.

use once_cell::sync::OnceCell;
use std::os::raw::c_int;

#[repr(C)]
#[derive(Default, Copy, Clone, Debug)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

extern "C" {
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> c_int;
}

/// Cached timebase. The kernel's timebase is fixed for the life of the process.
fn timebase() -> &'static MachTimebaseInfo {
    static T: OnceCell<MachTimebaseInfo> = OnceCell::new();
    T.get_or_init(|| {
        let mut info = MachTimebaseInfo::default();
        // SAFETY: trivial out-pointer.
        unsafe { mach_timebase_info(&mut info) };
        if info.denom == 0 {
            // Defensive: 1:1 fallback. Should not happen on macOS.
            info.numer = 1;
            info.denom = 1;
        }
        info
    })
}

/// Convert mach-absolute-time ticks to nanoseconds.
#[inline]
pub fn ticks_to_ns(ticks: u64) -> u64 {
    let tb = timebase();
    // Use u128 to avoid overflow on long-running processes (years of CPU).
    ((ticks as u128) * tb.numer as u128 / tb.denom as u128) as u64
}

/// Number of online (user-visible) CPUs. Cached.
#[allow(dead_code)]
pub fn num_cpus() -> usize {
    static N: OnceCell<usize> = OnceCell::new();
    *N.get_or_init(|| {
        // SAFETY: documented sysconf key, always returns a positive value.
        let n = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
        if n > 0 {
            n as usize
        } else {
            1
        }
    })
}

/// Compute one process' CPU% over a sampling interval.
///
/// `d_proc_ticks` is the delta of `pti_total_user + pti_total_system` between
/// two samples (mach absolute units). `d_wall_ns` is the wall-clock elapsed
/// nanoseconds across the same interval.
///
/// Returns "percent of one core" — matches Activity Monitor's column.
pub fn cpu_pct(d_proc_ticks: u64, d_wall_ns: u64) -> f64 {
    if d_wall_ns == 0 {
        return 0.0;
    }
    let d_proc_ns = ticks_to_ns(d_proc_ticks);
    (d_proc_ns as f64 / d_wall_ns as f64) * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timebase_is_sensible() {
        let tb = timebase();
        assert!(tb.numer > 0 && tb.denom > 0);
    }

    #[test]
    fn num_cpus_is_positive() {
        assert!(num_cpus() >= 1);
    }

    #[test]
    fn cpu_pct_zero_when_idle() {
        assert_eq!(cpu_pct(0, 1_000_000_000), 0.0);
    }
}
