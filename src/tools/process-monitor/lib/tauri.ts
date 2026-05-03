/**
 * Typed wrappers around the `pm_*` Tauri commands plus the live sample
 * event stream. Shapes mirror the Rust types in
 * `src-tauri/src/commands/process_monitor.rs` and `crates/zen-process-monitor`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ────────────────────────────────────────────────────────────────────────
// Domain types — keep in sync with the Rust DTOs.
// ────────────────────────────────────────────────────────────────────────

export interface ProcSummary {
  pid: number;
  ppid: number;
  name: string;
}

export interface PidStats {
  pid: number;
  ppid: number;
  pgid: number;
  name: string;
  root_pid: number;
  depth: number;
  is_ancestor: boolean;
  cpu_pct: number;
  rss: number;
  vsize: number;
  phys_footprint: number;
}

export interface TotalStats {
  cpu_pct: number;
  rss: number;
  vsize: number;
  phys_footprint: number;
  proc_count: number;
  root_count: number;
}

export interface Sample {
  ts: number;
  total: TotalStats;
  per_pid: PidStats[];
  ended_roots: number[];
}

export interface PmConfig {
  poll_ms: number;
  target_pids: number[];
}

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

export const pmTauri = {
  listProcesses: () => invoke<ProcSummary[]>("pm_list_processes"),
  addTarget: (pid: number) => invoke<void>("pm_add_target", { pid }),
  removeTarget: (pid: number) => invoke<void>("pm_remove_target", { pid }),
  setTargets: (pids: number[]) => invoke<void>("pm_set_targets", { pids }),
  clearTargets: () => invoke<void>("pm_clear_targets"),
  getConfig: () => invoke<PmConfig>("pm_get_config"),
  getHistory: () => invoke<Sample[]>("pm_get_history"),
  setPollInterval: (pollMs: number) =>
    invoke<void>("pm_set_poll_interval", { pollMs }),
  /**
   * Bring the main app window to the foreground from the menu-bar
   * popover (`?window=pm-popover`).
   */
  showMainWindow: () => invoke<void>("pm_show_main_window"),
  /** Close the menu-bar popover window. */
  popoverClose: () => invoke<void>("pm_popover_close"),
};

// ────────────────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────────────────

/** Subscribe to the live sample stream (`pm:sample`). */
export function listenSamples(
  cb: (sample: Sample) => void,
): Promise<UnlistenFn> {
  return listen<Sample>("pm:sample", (e) => cb(e.payload));
}

/** Subscribe to tray-driven "stop monitoring" events. */
export function listenTargetsCleared(cb: () => void): Promise<UnlistenFn> {
  return listen<null>("pm:targets-cleared", () => cb());
}
