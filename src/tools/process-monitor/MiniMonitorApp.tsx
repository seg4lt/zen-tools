/**
 * Mini popover view shown when the user left-clicks the menu-bar
 * tray icon.
 *
 * Lives in its own Tauri window (`pm-popover`, declared in
 * `tauri.conf.json`) so it can be small, frameless, and positioned
 * relative to the tray icon. Renders standalone — does NOT mount
 * the full `<App />` tree (no router, no provider chain). The
 * popover subscribes directly to the `pm:sample` event stream and
 * keeps only the latest sample in memory.
 *
 * Two actions:
 *   • "Open Full Window" — invokes `pm_show_main_window`, which
 *     focuses the main window and hides the popover.
 *   • Click anywhere outside — Tauri emits `tauri://blur` and we
 *     hide the window so it behaves like a native menu-bar panel.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { fmtBytes, fmtCpu, cpuSeverity } from "./lib/format";
import { pmTauri, type Sample } from "./lib/tauri";

export function MiniMonitorApp() {
  const [sample, setSample] = useState<Sample | null>(null);
  const [targetPids, setTargetPids] = useState<number[]>([]);

  // Bootstrap from the latest historical sample + current target list.
  // The sampler emits roughly every `poll_ms`, so the popover starts
  // populated even before the next tick fires.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [hist, cfg] = await Promise.all([
          pmTauri.getHistory(),
          pmTauri.getConfig(),
        ]);
        if (!alive) return;
        setTargetPids(cfg.target_pids);
        if (hist.length > 0) setSample(hist[hist.length - 1]);
      } catch (err) {
        console.warn("[mini-monitor] bootstrap failed", err);
      }
    })();

    const unlistenSample = listen<Sample>("pm:sample", (e) => {
      if (!alive) return;
      setSample(e.payload);
    });
    const unlistenCleared = listen<null>("pm:targets-cleared", () => {
      if (!alive) return;
      setTargetPids([]);
      setSample(null);
    });

    // Auto-hide on focus loss so the popover behaves like a real
    // status-bar panel. Without this the user has to click the tray
    // icon a second time to dismiss.
    const win = getCurrentWebviewWindow();
    const unlistenBlur = win.listen("tauri://blur", () => {
      win.hide().catch(() => {});
    });

    return () => {
      alive = false;
      unlistenSample.then((fn) => fn()).catch(() => {});
      unlistenCleared.then((fn) => fn()).catch(() => {});
      unlistenBlur.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Group per-pid stats by their root PID so we can show one row per
  // monitored target with its full subtree's totals.
  const perRoot = useMemo(() => {
    if (!sample) return [] as Array<{
      rootPid: number;
      name: string;
      cpu: number;
      rss: number;
      procCount: number;
    }>;
    const byRoot = new Map<number, { name: string; cpu: number; rss: number; n: number }>();
    for (const p of sample.per_pid) {
      const entry = byRoot.get(p.root_pid) ?? {
        name: "",
        cpu: 0,
        rss: 0,
        n: 0,
      };
      entry.cpu += p.cpu_pct;
      entry.rss += p.rss;
      entry.n += 1;
      // The root row has pid === root_pid; capture its name as the label.
      if (p.pid === p.root_pid) entry.name = p.name;
      byRoot.set(p.root_pid, entry);
    }
    // Preserve the order the user picked in.
    return targetPids
      .filter((pid) => byRoot.has(pid))
      .map((pid) => {
        const e = byRoot.get(pid)!;
        return {
          rootPid: pid,
          name: e.name || `pid ${pid}`,
          cpu: e.cpu,
          rss: e.rss,
          procCount: e.n,
        };
      });
  }, [sample, targetPids]);

  const openMain = async () => {
    try {
      await invoke("pm_show_main_window");
    } catch (err) {
      console.error("[mini-monitor] pm_show_main_window failed", err);
    }
  };

  const empty = targetPids.length === 0;

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-border/60 bg-background/95 text-foreground shadow-lg backdrop-blur"
      data-tauri-drag-region
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between border-b border-border/50 px-3 py-2"
        data-tauri-drag-region
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Process Monitor
        </span>
        <button
          type="button"
          onClick={openMain}
          className="flex items-center gap-1 rounded-md border border-border/50 bg-card px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
          title="Open the full Zen Tools window"
        >
          <ExternalLink className="size-3" />
          Open
        </button>
      </div>

      {/* Totals strip */}
      {sample && (
        <div className="flex shrink-0 items-baseline gap-3 border-b border-border/50 bg-card/40 px-3 py-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Total CPU
            </div>
            <div
              className="text-sm font-semibold tabular-nums"
              style={{ color: cpuSeverity(sample.total.cpu_pct) }}
            >
              {fmtCpu(sample.total.cpu_pct)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Total RSS
            </div>
            <div className="text-sm font-semibold tabular-nums">
              {fmtBytes(sample.total.rss)}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Procs
            </div>
            <div className="text-sm font-semibold tabular-nums">
              {sample.total.proc_count}
            </div>
          </div>
        </div>
      )}

      {/* Per-root list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No processes are being monitored.
          </div>
        ) : !sample ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            Awaiting first sample…
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {perRoot.map((row) => (
              <li
                key={row.rootPid}
                className="flex items-center gap-2 px-3 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={row.name}>
                    {row.name}
                  </div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    pid {row.rootPid} · {row.procCount} proc
                    {row.procCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="text-xs font-semibold tabular-nums"
                    style={{ color: cpuSeverity(row.cpu) }}
                  >
                    {fmtCpu(row.cpu)}
                  </div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {fmtBytes(row.rss)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
