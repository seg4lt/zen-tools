//! Process tree discovery.
//!
//! Strategy: enumerate all PIDs with `proc_listpids(ProcAllPIDS)` then call
//! `proc_pidinfo(PROC_PIDTASKALLINFO)` once per PID — that single call returns
//! both the BSD info (PPID, comm) AND the task info (CPU ticks, RSS, vsize)
//! we need for sampling. Doing one combined call instead of two halves the
//! syscall overhead and keeps the tree-walk and stats-collection in lockstep.
//!
//! `proc_listpids` is ~5 µs and `proc_pidinfo` is ~10–20 µs each, so a system
//! with 300 processes costs us ~5 ms total. Far below a 250 ms poll budget.

use libproc::libproc::bsd_info::BSDInfo;
use libproc::libproc::proc_pid::pidinfo;
use libproc::libproc::task_info::TaskAllInfo;
use libproc::processes::{pids_by_type, ProcFilter};
use std::collections::{HashMap, HashSet};
use std::ffi::CStr;

/// Lightweight process descriptor used internally for tree walking.
#[derive(Debug, Clone)]
pub struct ProcInfo {
    /// Process id.
    pub pid: i32,
    /// Parent process id.
    pub ppid: i32,
    /// POSIX process group leader's PID. Inherited across `fork()`, so even
    /// when a child has its `ppid` reset to launchd (the parent died, or the
    /// child detached via `dup2`/posix_spawn flags), `pgid` often still
    /// points back to the original launching process. We use this as a
    /// fallback to reconstruct hierarchy when PPID has been severed.
    /// Source: `proc_bsdinfo.pbi_pgid`.
    pub pgid: i32,
    /// macOS responsibility chain head — the process that the kernel
    /// considers "responsible" for this one's existence (e.g. for an XPC
    /// service spawned by launchd, this is the requesting app rather than
    /// launchd itself). Equals `pid` if the process is its own responsibility
    /// root, or the same as `ppid` for normal forks. Returned by the
    /// `responsibility_get_pid_responsible_for_pid` libsystem export — the
    /// same source Activity Monitor uses to group helpers under their app.
    pub resp_pid: i32,
    /// Executable name.
    pub name: String,
}

extern "C" {
    /// Exported from `libsystem_kernel.dylib`. Returns the "responsible" PID
    /// for `pid`. Used by Activity Monitor / lsappinfo to group XPC helpers
    /// (whose PPID is `launchd`) under their owning app.
    ///
    /// Returns the same PID when there is no override, or -1 on error
    /// (e.g. process exited mid-call). No entitlement required for processes
    /// the caller can otherwise introspect.
    fn responsibility_get_pid_responsible_for_pid(pid: libc::c_int) -> libc::c_int;
}

fn responsible_for(pid: i32) -> i32 {
    // SAFETY: trivial extern call with primitive args.
    let r = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
    if r <= 0 {
        pid
    } else {
        r
    }
}

/// "Logical parent" — the PID that should sit one level above `p` in a
/// human-meaningful process tree.
///
/// For most processes this is just PPID. The override fires for XPC services
/// and helpers, where PPID is `launchd` (1) but responsibility points back
/// to the actual host app. This is exactly what Activity Monitor does to
/// surface XPC helpers, "Open and Save Panel Service", WebContent processes,
/// etc. as children of their host.
pub fn logical_parent(p: &ProcInfo) -> i32 {
    if p.ppid == 1 && p.resp_pid > 1 && p.resp_pid != p.pid {
        p.resp_pid
    } else {
        p.ppid
    }
}

/// Convert the `[c_char; N]` `pbi_comm` / `pbi_name` fields to a Rust string.
pub(crate) fn comm_to_string(comm: &[i8]) -> String {
    // SAFETY: `pbi_comm` and `pbi_name` are NUL-terminated by the kernel.
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(comm.as_ptr() as *const u8, comm.len()) };
    CStr::from_bytes_until_nul(bytes)
        .ok()
        .and_then(|c| c.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Read pid+ppid+name for every process the caller can see. Sorted by pid.
pub fn list_all() -> Result<Vec<ProcInfo>, String> {
    let pids = pids_by_type(ProcFilter::All).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(pids.len());
    for pid in pids {
        let pid = pid as i32;
        if pid <= 0 {
            continue;
        }
        // Some kernel processes (pid 0) and short-lived ones may fail this
        // call — skip silently rather than poisoning the whole list.
        let info = match pidinfo::<BSDInfo>(pid, 0) {
            Ok(i) => i,
            Err(_) => continue,
        };
        // Prefer the longer 32-byte `pbi_name` if set; else fall back to the
        // 16-byte `pbi_comm` (which is the truncated executable basename).
        let mut name = comm_to_string(&info.pbi_name);
        if name.is_empty() {
            name = comm_to_string(&info.pbi_comm);
        }
        let pid_i32 = info.pbi_pid as i32;
        out.push(ProcInfo {
            pid: pid_i32,
            ppid: info.pbi_ppid as i32,
            pgid: info.pbi_pgid as i32,
            resp_pid: responsible_for(pid_i32),
            name,
        });
    }
    out.sort_by_key(|p| p.pid);
    Ok(out)
}

/// DFS the process table to find every descendant of `root_pid` (inclusive).
/// Returns each process paired with its depth from the root (0 = root).
/// Returns an empty Vec if the root is not running.
///
/// Membership uses three relations: responsibility chain, PPID transitive,
/// and PGID transitive — see the source for the full rationale.
pub fn descendants_of(root_pid: i32, all: &[ProcInfo]) -> Vec<(ProcInfo, u32)> {
    let mut by_pid: HashMap<i32, usize> = HashMap::new();
    let mut by_ppid: HashMap<i32, Vec<usize>> = HashMap::new();
    let mut by_pgid: HashMap<i32, Vec<usize>> = HashMap::new();
    for (i, p) in all.iter().enumerate() {
        by_pid.insert(p.pid, i);
        by_ppid.entry(p.ppid).or_default().push(i);
        if p.pgid > 0 {
            by_pgid.entry(p.pgid).or_default().push(i);
        }
    }

    if !by_pid.contains_key(&root_pid) {
        return Vec::new();
    }

    // ---- Step 1: compute membership (transitive over ppid AND pgid) ----
    let mut members: HashSet<i32> = HashSet::from([root_pid]);

    // (a) Responsibility children of root.
    for p in all {
        if p.resp_pid == root_pid && p.pid != root_pid {
            members.insert(p.pid);
        }
    }

    // (b/c) Transitive closure via ppid + pgid.
    let mut frontier: Vec<i32> = members.iter().copied().collect();
    while let Some(pid) = frontier.pop() {
        if let Some(kids) = by_ppid.get(&pid) {
            for &cidx in kids {
                let cpid = all[cidx].pid;
                if cpid != pid && members.insert(cpid) {
                    frontier.push(cpid);
                }
            }
        }
        if let Some(kids) = by_pgid.get(&pid) {
            for &cidx in kids {
                let cpid = all[cidx].pid;
                if cpid != pid && members.insert(cpid) {
                    frontier.push(cpid);
                }
            }
        }
    }

    // ---- Step 2: decide each member's in-tree parent ----
    let mut children_in_tree: HashMap<i32, Vec<usize>> = HashMap::new();
    for (i, p) in all.iter().enumerate() {
        if p.pid == root_pid || !members.contains(&p.pid) {
            continue;
        }
        let parent = if members.contains(&p.ppid) && p.ppid != p.pid {
            p.ppid
        } else if p.pgid > 0
            && p.pgid != p.pid
            && p.pgid != root_pid
            && members.contains(&p.pgid)
        {
            p.pgid
        } else {
            root_pid
        };
        children_in_tree.entry(parent).or_default().push(i);
    }

    // ---- Step 3: pre-order DFS ----
    let mut out: Vec<(ProcInfo, u32)> = Vec::new();
    let mut seen: HashSet<i32> = HashSet::new();
    let mut stack: Vec<(i32, u32)> = vec![(root_pid, 0)];
    while let Some((pid, depth)) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(&idx) = by_pid.get(&pid) {
            out.push((all[idx].clone(), depth));
        }
        if let Some(kids) = children_in_tree.get(&pid) {
            for &cidx in kids.iter().rev() {
                stack.push((all[cidx].pid, depth + 1));
            }
        }
    }
    out
}

/// Read combined BSD + task info for one PID in a single syscall. Returns
/// `None` if the process exited between enumeration and this call.
pub fn task_all_info(pid: i32) -> Option<TaskAllInfo> {
    pidinfo::<TaskAllInfo>(pid, 0).ok()
}

/// Cap on the ancestor walk. Modern macOS sessions have shallow chains
/// (typically 5–8 levels); 16 is a generous safety bound against
/// pathological cycles.
const MAX_ANCESTORS: usize = 16;

/// Walk the parent chain of `pid` upward via `logical_parent`. Returns
/// ancestors in **closest-first** order: index 0 is the direct parent,
/// last element is the root-most ancestor (typically `launchd`, pid 1).
///
/// `pid` itself is **not** included.
pub fn ancestors_of(pid: i32, all: &[ProcInfo]) -> Vec<ProcInfo> {
    let by_pid: HashMap<i32, &ProcInfo> = all.iter().map(|p| (p.pid, p)).collect();

    let Some(start) = by_pid.get(&pid) else {
        return Vec::new();
    };
    let mut out: Vec<ProcInfo> = Vec::new();
    let mut current = logical_parent(start);
    while current > 0 && current != pid && out.len() < MAX_ANCESTORS {
        match by_pid.get(&current) {
            Some(p) => {
                out.push((*p).clone());
                let next = logical_parent(p);
                if next == p.pid {
                    break;
                } // self-loop guard
                current = next;
            }
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_includes_self() {
        let me = std::process::id() as i32;
        let all = list_all().expect("list_all");
        assert!(all.iter().any(|p| p.pid == me), "self pid not in list");
    }

    #[test]
    fn descendants_of_self_includes_self() {
        let me = std::process::id() as i32;
        let all = list_all().expect("list_all");
        let tree = descendants_of(me, &all);
        let root = tree.iter().find(|(p, _)| p.pid == me);
        assert!(root.is_some(), "self pid not in own tree");
        assert_eq!(root.unwrap().1, 0, "self should be at depth 0");
    }

    #[test]
    fn responsible_pid_for_self_is_sane() {
        let me = std::process::id() as i32;
        let r = responsible_for(me);
        assert!(r > 0, "responsible_for returned {r}");
    }
}
