/**
 * One-process graph card: CPU + Memory sparklines for a single monitored
 * root. Clicking sets it as the dashboard's active target.
 *
 * Port of `frontend/src/components/process_graph.rs`.
 */

import { useMemo } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtBytes, fmtCpu } from "../lib/format";
import type { Sample } from "../lib/tauri";
import { Sparkline } from "./Sparkline";

export interface ProcessGraphProps {
  rootPid: number;
  history: Sample[];
  isActive: boolean;
  onClick: () => void;
  onRemove: (pid: number) => void;
}

export function ProcessGraph({
  rootPid,
  history,
  isActive,
  onClick,
  onRemove,
}: ProcessGraphProps) {
  // Latest non-ancestor target row for this root — name + proc count + ended state.
  const meta = useMemo(() => {
    const last = history[history.length - 1];
    if (!last) return { name: null as string | null, count: 0, ended: false };
    let name: string | null = null;
    let count = 0;
    let foundRoot = false;
    for (const r of last.per_pid) {
      if (r.root_pid === rootPid && !r.is_ancestor) {
        if (r.depth === 0) {
          name = r.name;
          foundRoot = true;
        }
        count += 1;
      }
    }
    const listedEnded = last.ended_roots.includes(rootPid);
    return { name, count, ended: !foundRoot || listedEnded };
  }, [history, rootPid]);

  const cpuSeries = useMemo(
    () =>
      history.map((s) =>
        s.per_pid
          .filter((p) => p.root_pid === rootPid && !p.is_ancestor)
          .reduce((acc, p) => acc + p.cpu_pct, 0),
      ),
    [history, rootPid],
  );
  const memSeries = useMemo(
    () =>
      history.map((s) =>
        s.per_pid
          .filter((p) => p.root_pid === rootPid && !p.is_ancestor)
          .reduce((acc, p) => acc + p.phys_footprint, 0),
      ),
    [history, rootPid],
  );

  const cpuNow = cpuSeries.length > 0 ? cpuSeries[cpuSeries.length - 1] : 0;
  const memNow = memSeries.length > 0 ? memSeries[memSeries.length - 1] : 0;
  const headerName = meta.name ?? `pid ${rootPid}`;

  return (
    <div
      onClick={onClick}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-card/80",
        isActive && "border-primary ring-1 ring-primary/40",
        meta.ended && "opacity-60",
      )}
      title="Click to view this process's tree"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-xs",
            isActive ? "text-primary" : "text-transparent",
          )}
        >
          ●
        </span>
        <span className="flex-1 truncate text-sm font-medium" title={headerName}>
          {headerName}
        </span>
        <span className="text-xs text-muted-foreground">
          #{rootPid}
          {meta.count > 1 ? ` · ${meta.count} procs` : ""}
        </span>
        <button
          type="button"
          title="Stop monitoring this process"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(rootPid);
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="w-12 text-muted-foreground">CPU</span>
          <div className="flex-1">
            <Sparkline
              values={cpuSeries}
              color="var(--accent, #60a5fa)"
              height={28}
            />
          </div>
          <span className="w-16 text-right tabular-nums">{fmtCpu(cpuNow)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-12 text-muted-foreground">Mem</span>
          <div className="flex-1">
            <Sparkline
              values={memSeries}
              color="var(--good, #22c55e)"
              height={28}
            />
          </div>
          <span className="w-16 text-right tabular-nums">{fmtBytes(memNow)}</span>
        </div>
      </div>
    </div>
  );
}
