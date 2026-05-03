/**
 * Typed wrappers around the `pm_*` Tauri commands plus the live sample
 * event stream.
 *
 * **DTOs are generated from Rust** by ts-rs and re-exported here so
 * the rest of the tool's code (components, hooks, store) keeps its
 * existing imports while the wire shapes stay in lock-step with the
 * Rust source. The generator runs as `cargo test export_bindings`;
 * see docs/IPC.md → "Generating TS bindings" for the recipe.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ────────────────────────────────────────────────────────────────────────
// Domain types — generated from Rust via ts-rs.
// ────────────────────────────────────────────────────────────────────────

export type {
  PidSample,
  PidStats,
  PmConfig,
  ProcSummary,
  Sample,
  TotalStats,
} from "@zen-tools/types/generated";

import type {
  PmConfig,
  ProcSummary,
  Sample,
} from "@zen-tools/types/generated";

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
