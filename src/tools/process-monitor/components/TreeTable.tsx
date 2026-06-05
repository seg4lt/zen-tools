/**
 * Process tree, with ancestor context shown above each target.
 *
 * Per `root_pid`, the table renders three sections stacked top-to-bottom:
 *   1. Ancestors (dimmed) — root-most first → direct parent.
 *   2. Target row (the rollup, bold). Click the row to show the command;
 *      click the chevron to collapse the descendant subtree.
 *   3. Descendants (when expanded) — DFS order, indented by depth.
 *
 * Port of `frontend/src/components/tree_table.rs`.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@zen-tools/ui";
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
  const [selectedPid, setSelectedPid] = useState<number | null>(null);

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

  const toggleCommand = (pid: number) => {
    setSelectedPid((prev) => (prev === pid ? null : pid));
  };

  const commandRow = (row: PidStats, key: string, padEm = 0) =>
    selectedPid === row.pid ? (
      <tr key={key} className="bg-muted/20">
        <td colSpan={6} className="px-2 pb-2 pt-1">
          <div
            className="h-24 overflow-y-auto rounded border border-border/70 bg-background/80 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground"
            style={{ marginLeft: padEm ? `${padEm}em` : undefined }}
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Command
            </div>
            <div className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
              {row.command || row.name}
            </div>
          </div>
        </td>
      </tr>
    ) : null;

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
            <th
              className="px-2 py-1.5 text-left"
              title="Total threads (proc_taskinfo.pti_threadnum)"
            >
              Threads
            </th>
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
            // Sum threads across the entire monitored subtree (target +
            // every descendant) so the target row's "Threads" cell is
            // an at-a-glance total for the whole tree, matching how the
            // CPU/Memory/RSS columns also reflect the rolled-up cost.
            // Ancestors are excluded (same rule as the rest of the
            // totals — see `sampler.rs::collect_sample_macos`).
            const treeThreads =
              (targetRow?.threads ?? 0) +
              g.descendants.reduce((acc, d) => acc + (d.threads ?? 0), 0);

            return [
              <tr
                key={`${pid}-h`}
                className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground"
              >
                <td colSpan={6} className="px-2 py-1">
                  <span className="text-primary">●</span>{" "}
                  Tree of <span className="font-semibold normal-case text-foreground">{groupLabel}</span>{" "}
                  <span className="text-muted-foreground"> #{pid}</span>
                </td>
              </tr>,
              ...g.ancestors.flatMap((a) => {
                const padEm = (maxAncDistance - a.depth) * 0.8 + 0.4;
                return [
                  <tr
                    key={`${pid}-a-${a.pid}`}
                    title="Click to show full command. Ancestor — context only, not in totals"
                    onClick={() => toggleCommand(a.pid)}
                    className={cn(
                      "cursor-pointer text-muted-foreground hover:bg-muted/30",
                      selectedPid === a.pid && "bg-muted/30 text-foreground",
                    )}
                  >
                    <td className="py-1" style={{ paddingLeft: `${padEm}em` }}>
                      <span className="mr-1">↑</span>
                      {a.name}
                    </td>
                    <td className="px-2 py-1">{a.pid}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtCpu(a.cpu_pct)}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtBytes(a.phys_footprint)}</td>
                    <td className="px-2 py-1 tabular-nums">{fmtBytes(a.rss)}</td>
                    <td className="px-2 py-1 tabular-nums">{a.threads}</td>
                  </tr>,
                  commandRow(a, `${pid}-a-${a.pid}-cmd`, padEm),
                ];
              }),
              <tr
                key={`${pid}-t`}
                onClick={() => targetRow && toggleCommand(targetRow.pid)}
                className={cn(
                  "border-t bg-card/40 font-medium",
                  "cursor-pointer hover:bg-muted/40",
                  targetRow && selectedPid === targetRow.pid && "bg-muted/40",
                )}
                title="Click to show full command"
              >
                <td className="px-2 py-1">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-4 items-center justify-center rounded text-muted-foreground",
                      hasChildren && "hover:bg-muted hover:text-foreground",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (hasChildren) toggle(pid);
                    }}
                    aria-label={isOpen ? "Collapse process tree" : "Expand process tree"}
                    disabled={!hasChildren}
                  >
                    {Chevron ? <Chevron className="size-3.5" /> : null}
                  </button>{" "}
                  {targetRow?.name ?? `pid ${pid}`}
                  {g.procCount > 1 && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      · {g.procCount} procs in tree
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {targetRow?.pid ?? pid}
                </td>
                <td className="px-2 py-1 tabular-nums" style={{ color: cpuSeverity(selfCpu) }}>
                  {fmtCpu(selfCpu)}
                </td>
                <td className="px-2 py-1 tabular-nums">{fmtBytes(selfMem)}</td>
                <td className="px-2 py-1 tabular-nums text-muted-foreground">{fmtBytes(selfRss)}</td>
                <td
                  className="px-2 py-1 tabular-nums"
                  title={
                    g.descendants.length > 0
                      ? `${targetRow?.threads ?? 0} on this process + ${
                          treeThreads - (targetRow?.threads ?? 0)
                        } across descendants`
                      : `${treeThreads} threads`
                  }
                >
                  {treeThreads}
                </td>
              </tr>,
              targetRow ? commandRow(targetRow, `${pid}-t-cmd`) : null,
              ...(isOpen
                ? g.descendants.flatMap((d) => {
                    const depth = Math.max(1, d.depth);
                    const padEm = depth * 1.6 + 0.4;
                    const viaPgid = d.ppid === 1 && d.pgid > 1 && d.pgid !== d.pid;
                    return [
                      <tr
                        key={`${pid}-d-${d.pid}`}
                        onClick={() => toggleCommand(d.pid)}
                        className={cn(
                          "cursor-pointer hover:bg-muted/30",
                          selectedPid === d.pid && "bg-muted/30",
                        )}
                        title="Click to show full command"
                      >
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
                        <td className="px-2 py-1 tabular-nums text-muted-foreground">{d.threads}</td>
                      </tr>,
                      commandRow(d, `${pid}-d-${d.pid}-cmd`, padEm),
                    ];
                  })
                : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
