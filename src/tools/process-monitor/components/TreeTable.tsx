/**
 * Process tree, with ancestor context shown above each target.
 *
 * Per `root_pid`, the table renders three sections stacked top-to-bottom:
 *   1. Ancestors (dimmed) — root-most first → direct parent.
 *   2. Target row (the rollup, bold). Click to collapse the descendant subtree.
 *   3. Descendants (when expanded) — DFS order, indented by depth.
 *
 * Port of `frontend/src/components/tree_table.rs`.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { cpuSeverity, fmtBytes, fmtCpu } from "../lib/format";
import type { PidStats, Sample } from "../lib/tauri";

interface Group {
  rootPid: number;
  ancestors: PidStats[];
  target: PidStats | null;
  descendants: PidStats[];
  procCount: number;
}

function groupRows(rows: PidStats[]): Group[] {
  const buckets = new Map<number, Group>();
  const order: number[] = [];
  for (const r of rows) {
    if (!buckets.has(r.root_pid)) {
      order.push(r.root_pid);
      buckets.set(r.root_pid, {
        rootPid: r.root_pid,
        ancestors: [],
        target: null,
        descendants: [],
        procCount: 0,
      });
    }
    const g = buckets.get(r.root_pid)!;
    if (r.is_ancestor) g.ancestors.push(r);
    else if (r.depth === 0) {
      g.target = r;
      g.procCount += 1;
    } else {
      g.descendants.push(r);
      g.procCount += 1;
    }
  }
  return order.map((pid) => buckets.get(pid)!).filter(Boolean);
}

export interface TreeTableProps {
  latest: Sample | null;
  activeTarget: number | null;
}

export function TreeTable({ latest, activeTarget }: TreeTableProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const groups = useMemo(() => {
    if (!latest) return [];
    let g = groupRows(latest.per_pid);
    if (activeTarget != null) g = g.filter((x) => x.rootPid === activeTarget);
    return g;
  }, [latest, activeTarget]);

  if (!latest) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Awaiting first sample…
      </div>
    );
  }
  if (latest.per_pid.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <span>All monitored processes have ended.</span>
        <span className="text-xs">Pick another from the picker.</span>
      </div>
    );
  }

  const toggle = (pid: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(pid)) next.add(pid);
      return next;
    });
  };

  return (
    <div className="h-full overflow-y-auto px-1">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">Process</th>
            <th className="px-2 py-1.5 text-left">PID</th>
            <th className="px-2 py-1.5 text-left">CPU</th>
            <th className="px-2 py-1.5 text-left">Memory</th>
            <th className="px-2 py-1.5 text-left">RSS</th>
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((g) => {
            const pid = g.rootPid;
            const isOpen = !collapsed.has(pid);
            const hasChildren = g.descendants.length > 0;
            const Chevron = !hasChildren ? null : isOpen ? ChevronDown : ChevronRight;

            const groupLabel = g.target?.name ?? `pid ${pid}`;
            const maxAncDistance = g.ancestors.reduce(
              (m, a) => Math.max(m, a.depth),
              0,
            );

            const targetRow = g.target;
            const selfCpu = targetRow?.cpu_pct ?? 0;
            const selfMem = targetRow?.phys_footprint ?? 0;
            const selfRss = targetRow?.rss ?? 0;

            return [
              <tr
                key={`${pid}-h`}
                className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground"
              >
                <td colSpan={5} className="px-2 py-1">
                  <span className="text-primary">●</span>{" "}
                  Tree of <span className="font-semibold normal-case text-foreground">{groupLabel}</span>{" "}
                  <span className="text-muted-foreground"> #{pid}</span>
                </td>
              </tr>,
              ...g.ancestors.map((a) => {
                const padEm = (maxAncDistance - a.depth) * 0.8 + 0.4;
                return (
                  <tr
                    key={`${pid}-a-${a.pid}`}
                    title="Ancestor — context only, not in totals"
                    className="text-muted-foreground"
                  >
                    <td className="py-1" style={{ paddingLeft: `${padEm}em` }}>
                      <span className="mr-1">↑</span>
                      {a.name}
                    </td>
                    <td className="px-2 py-1">{a.pid}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtCpu(a.cpu_pct)}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtBytes(a.phys_footprint)}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtBytes(a.rss)}</td>
                  </tr>
                );
              }),
              <tr
                key={`${pid}-t`}
                onClick={() => hasChildren && toggle(pid)}
                className={cn(
                  "border-t bg-card/40 font-medium",
                  hasChildren && "cursor-pointer hover:bg-muted/40",
                )}
              >
                <td className="px-2 py-1">
                  <span className="inline-flex w-4 justify-center text-muted-foreground">
                    {Chevron ? <Chevron className="size-3.5" /> : null}
                  </span>{" "}
                  {targetRow?.name ?? `pid ${pid}`}
                  {g.procCount > 1 && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      · {g.procCount} procs in tree
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-muted-foreground">{pid}</td>
                <td className="px-2 py-1 tabular-nums" style={{ color: cpuSeverity(selfCpu) }}>
                  {fmtCpu(selfCpu)}
                </td>
                <td className="px-2 py-1 tabular-nums">{fmtBytes(selfMem)}</td>
                <td className="px-2 py-1 tabular-nums text-muted-foreground">{fmtBytes(selfRss)}</td>
              </tr>,
              ...(isOpen
                ? g.descendants.map((d) => {
                    const depth = Math.max(1, d.depth);
                    const padEm = depth * 1.6 + 0.4;
                    const viaPgid = d.ppid === 1 && d.pgid > 1 && d.pgid !== d.pid;
                    return (
                      <tr key={`${pid}-d-${d.pid}`}>
                        <td className="py-1" style={{ paddingLeft: `${padEm}em` }}>
                          <span className="mr-1 text-muted-foreground">
                            {viaPgid ? "↳" : "└─"}
                          </span>
                          {d.name}
                          {viaPgid && (
                            <span
                              className="ml-1 text-xs text-muted-foreground"
                              title="Linked via PGID — original parent has detached or exited"
                            >
                              · pgid {d.pgid}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">{d.pid}</td>
                        <td className="px-2 py-1 tabular-nums" style={{ color: cpuSeverity(d.cpu_pct) }}>
                          {fmtCpu(d.cpu_pct)}
                        </td>
                        <td className="px-2 py-1 tabular-nums">{fmtBytes(d.phys_footprint)}</td>
                        <td className="px-2 py-1 tabular-nums text-muted-foreground">{fmtBytes(d.rss)}</td>
                      </tr>
                    );
                  })
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
