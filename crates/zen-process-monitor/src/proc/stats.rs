//! Per-PID stat collection: combined `proc_taskallinfo` + `rusage_info_v4`.
//!
//! `proc_taskallinfo` gives us PPID, comm, CPU ticks (`pti_total_user +
//! pti_total_system`), RSS (`pti_resident_size`) and vsize (`pti_virtual_size`)
//! in one call. A second call to `proc_pid_rusage(V4)` adds `ri_phys_footprint`
//! — the value that powers Activity Monitor's "Memory" column.

use super::{tree, PidSample};
use libproc::libproc::pid_rusage::{pidrusage, RUsageInfoV4};

/// Read a full sample for one PID. Returns `None` if the process has exited
/// or the kernel refuses (e.g. SIP-protected PIDs we can't introspect).
pub fn read(pid: i32) -> Option<PidSample> {
    let tai = tree::task_all_info(pid)?;
    let mut name = tree::comm_to_string(&tai.pbsd.pbi_name);
    if name.is_empty() {
        name = tree::comm_to_string(&tai.pbsd.pbi_comm);
    }

    let phys_footprint = pidrusage::<RUsageInfoV4>(pid)
        .map(|r| r.ri_phys_footprint)
        .unwrap_or(0);

    Some(PidSample {
        pid,
        ppid: tai.pbsd.pbi_ppid as i32,
        pgid: tai.pbsd.pbi_pgid as i32,
        name,
        cpu_ticks: tai.ptinfo.pti_total_user + tai.ptinfo.pti_total_system,
        rss: tai.ptinfo.pti_resident_size,
        vsize: tai.ptinfo.pti_virtual_size,
        phys_footprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_self_succeeds() {
        let me = std::process::id() as i32;
        let s = read(me).expect("read self");
        assert_eq!(s.pid, me);
        assert!(s.rss > 0, "rss should be > 0");
    }
}
