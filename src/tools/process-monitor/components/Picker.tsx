/**
 * Multi-select process picker.
 *
 * UX (matches the original Leptos picker):
 *   - Search box filters by name or PID.
 *   - Click a row to toggle selection (✓ indicator).
 *   - Selected processes show as removable chips above the list.
 *   - "Monitor (N)" button commits the selection — invokes `pm_set_targets`
 *     and routes the store to the dashboard view.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { pmTauri, type ProcSummary } from "../lib/tauri";
import { useProcessMonitorStore } from "../store/process-monitor-store";

const MAX_ROWS = 100;

export function Picker() {
  const { state, dispatch } = useProcessMonitorStore();
  const [processes, setProcesses] = useState<ProcSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  // Local mutable selection so the user can pick several before committing.
  const [selected, setSelected] = useState<number[]>(state.targets);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await pmTauri.listProcesses();
      setProcesses(list);
    } catch (err) {
      console.warn("[picker] list_processes failed", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return processes.slice(0, MAX_ROWS);
    const out: ProcSummary[] = [];
    for (const p of processes) {
      if (p.name.toLowerCase().includes(q) || String(p.pid).includes(q)) {
        out.push(p);
        if (out.length >= MAX_ROWS) break;
      }
    }
    return out;
  }, [processes, query]);

  const toggle = (pid: number) => {
    setSelected((cur) =>
      cur.includes(pid) ? cur.filter((p) => p !== pid) : [...cur, pid],
    );
  };

  const commit = async () => {
    if (selected.length === 0) return;
    try {
      await pmTauri.setTargets(selected);
      dispatch({ type: "setTargets", pids: selected });
    } catch (err) {
      console.error("[picker] set_targets failed", err);
    }
  };

  const cancel = () => {
    if (state.targets.length > 0) {
      dispatch({ type: "view", view: "dashboard" });
    }
  };

  // Resolve names for chips, falling back to "pid N" when the process
  // hasn't been loaded yet.
  const chips = useMemo(
    () =>
      selected.map((pid) => ({
        pid,
        name:
          processes.find((p) => p.pid === pid)?.name ?? `pid ${pid}`,
      })),
    [selected, processes],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b bg-card/40 px-3 py-2">
          {chips.map((c) => (
            <span
              key={c.pid}
              className="inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-xs"
            >
              <span className="max-w-[160px] truncate">{c.name}</span>
              <span className="text-muted-foreground">· {c.pid}</span>
              <button
                type="button"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(c.pid);
                }}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="border-b px-3 py-2">
        <input
          type="text"
          autoFocus
          placeholder="Search by name or PID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading processes…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>No processes match.</span>
            <span className="text-xs">Try a shorter query or click Refresh.</span>
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((p) => {
              const isSel = selectedSet.has(p.pid);
              return (
                <li
                  key={p.pid}
                  onClick={() => toggle(p.pid)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/60",
                    isSel && "bg-accent/40",
                  )}
                >
                  <span className="flex size-4 items-center justify-center text-primary">
                    {isSel ? <Check className="size-3.5" /> : null}
                  </span>
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    #{p.pid}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t bg-card/60 px-3 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          title="Refresh process list"
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        {state.targets.length > 0 && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
        <div className="ml-auto" />
        <Button
          size="sm"
          disabled={selected.length === 0}
          onClick={commit}
        >
          {selected.length === 0
            ? "Pick a process"
            : selected.length === 1
              ? "Monitor 1 process"
              : `Monitor ${selected.length} processes`}
        </Button>
      </div>
    </div>
  );
}
