/**
 * Live dashboard.
 *
 * Layout (top → bottom):
 *   1. Per-target graph cards (one per monitored target). Click to switch
 *      the active target. Sparklines + current values per card.
 *   2. Process tree (ancestor chain + target row + descendants) for the
 *      active target.
 *
 * The per-card CPU / Memory readouts and the tree's root + descendant rows
 * already show every value the old "Total tree / <name> only" metric split
 * surfaced, so that section was removed for being duplicate information.
 *
 * Port of `frontend/src/components/dashboard.rs`.
 */

import { fmtBytes } from "../lib/format";
import { pmTauri } from "../lib/tauri";
import { useProcessMonitorStore } from "../store/process-monitor-store";
import { ProcessGraph } from "./ProcessGraph";
import { TreeTable } from "./TreeTable";

function fmtTime(ts: number) {
  const secs = Math.floor(ts / 1000);
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor(secs / 60) % 60;
  const s = secs % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function Dashboard() {
  const { state, dispatch } = useProcessMonitorStore();
  const latest = state.history[state.history.length - 1] ?? null;

  const onRemove = async (pid: number) => {
    try {
      await pmTauri.removeTarget(pid);
      dispatch({ type: "removeTarget", pid });
    } catch (err) {
      console.error("[dashboard] remove_target failed", err);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3">
      {/* Per-target cards */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {state.targets.map((pid) => (
          <ProcessGraph
            key={pid}
            rootPid={pid}
            history={state.history}
            isActive={state.activeTarget === pid}
            onClick={() => dispatch({ type: "setActive", pid })}
            onRemove={onRemove}
          />
        ))}
      </div>

      {/* Tree of active target */}
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
        <div className="border-b px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Process tree
        </div>
        <div className="min-h-0 flex-1">
          <TreeTable latest={latest} activeTarget={state.activeTarget} />
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {latest
          ? `Updated ${fmtTime(latest.ts)} · RSS ${fmtBytes(latest.total.rss)} · VM ${fmtBytes(latest.total.vsize)}`
          : "Awaiting first sample…"}
      </div>
    </div>
  );
}
