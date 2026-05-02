/**
 * API Stats tab — live view of `gh` CLI invocations + an AI-runs panel
 * that records what provider / model each summary actually used.
 *
 * The AI panel is the diagnostic checkpoint for "did Settings actually
 * propagate?". Every `engine.ai_summary()` invocation pushes a record
 * (provider, resolved model, repo, date range, duration, success,
 * commit count, cost) into a 200-entry rolling log on the engine, and
 * we render it here newest-first.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  prmasterTauri,
  type AiRunRecord,
  type GhCall,
} from "../../lib/tauri";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "../shared/density";

export function ApiStatsTab() {
  const [calls, setCalls] = useState<GhCall[]>([]);
  const [aiRuns, setAiRuns] = useState<AiRunRecord[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchOnce() {
    try {
      const [callLog, runs] = await Promise.all([
        prmasterTauri.getCallLog(),
        prmasterTauri.getAiRuns(),
      ]);
      setCalls(callLog);
      setAiRuns(runs);
    } catch (err) {
      console.warn("[api-stats] fetch failed:", err);
    }
  }

  useEffect(() => {
    void fetchOnce();
    if (autoRefresh) {
      intervalRef.current = setInterval(() => void fetchOnce(), 2000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [autoRefresh]);

  const totals = useMemo(() => {
    const total = calls.length;
    const failures = calls.filter((c) => !c.success).length;
    const avgMs =
      total === 0 ? 0 : calls.reduce((s, c) => s + c.duration_ms, 0) / total;
    return { total, failures, avgMs };
  }, [calls]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">API stats</h2>
          <span className="text-xs text-muted-foreground">
            {totals.total} calls · {totals.failures} failures · avg{" "}
            {totals.avgMs.toFixed(0)}ms · {aiRuns.length} AI runs
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Label
            htmlFor="auto"
            className="cursor-pointer text-xs font-normal text-muted-foreground"
          >
            <Switch
              id="auto"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            Auto-refresh (2s)
          </Label>
          <Button size="sm" variant="ghost" onClick={() => void fetchOnce()}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <AiRunsPanel runs={aiRuns} />

        {calls.length === 0 ? (
          <Panel className="border-dashed">
            <PanelContent className="my-8 flex flex-col items-center gap-1.5 py-6 text-center text-xs text-muted-foreground">
              <p>No `gh` calls yet.</p>
              <p>
                Switch to another tab and trigger a refresh — calls show up
                here in real time.
              </p>
            </PanelContent>
          </Panel>
        ) : (
          <Panel>
            <PanelHeader>
              <PanelTitle>gh CLI calls</PanelTitle>
              <span className="text-[10px] text-muted-foreground">
                {calls.length} total
              </span>
            </PanelHeader>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-[10px] tracking-wide text-muted-foreground uppercase">
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">When</th>
                  <th className="w-full px-2 py-1.5 font-medium">Command</th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...calls].reverse().map((call, i) => (
                  <tr
                    key={`${call.timestamp}-${i}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-2 py-1">
                      {call.success ? (
                        <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="size-3.5 text-destructive" />
                      )}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                      {new Date(call.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      <span
                        className={cn(!call.success && "text-destructive")}
                      >
                        {call.command}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      <Badge
                        variant={
                          call.duration_ms > 5000
                            ? "destructive"
                            : call.duration_ms > 1500
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {call.duration_ms.toFixed(0)}ms
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}

function AiRunsPanel({ runs }: { runs: AiRunRecord[] }) {
  return (
    <Panel>
      <PanelHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-purple-500" />
          <PanelTitle>AI runs</PanelTitle>
          <span className="text-[10px] text-muted-foreground">
            {runs.length === 0
              ? "no runs yet"
              : `${runs.length} ${runs.length === 1 ? "run" : "runs"} (newest first)`}
          </span>
        </div>
      </PanelHeader>
      {runs.length === 0 ? (
        <PanelContent className="px-3 py-2 text-xs text-muted-foreground">
          Trigger Generate on the AI Summary tab and the resolved provider +
          model + range will appear here so you can verify Settings is
          actually being applied.
        </PanelContent>
      ) : (
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b text-left text-[10px] tracking-wide text-muted-foreground uppercase">
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="px-2 py-1.5 font-medium">Provider</th>
              <th className="px-2 py-1.5 font-medium">Model</th>
              <th className="px-2 py-1.5 font-medium">Repo</th>
              <th className="px-2 py-1.5 font-medium">Range</th>
              <th className="px-2 py-1.5 text-right font-medium">Commits</th>
              <th className="px-2 py-1.5 text-right font-medium">Cost</th>
              <th className="px-2 py-1.5 text-right font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <tr
                key={`${r.timestamp}-${r.repo}-${i}`}
                className="border-b last:border-b-0"
              >
                <td className="px-2 py-1">
                  {r.success ? (
                    <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <XCircle className="size-3.5 text-destructive" />
                  )}
                </td>
                <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                  {new Date(r.timestamp).toLocaleTimeString()}
                </td>
                <td className="px-2 py-1 font-mono">{r.provider}</td>
                <td className="px-2 py-1 font-mono">
                  {r.model ?? (
                    <span className="italic text-muted-foreground">
                      (provider default)
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 font-mono">{r.repo}</td>
                <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                  {formatRangeShort(r.since, r.until)}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  {r.commit_count}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  {r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : "—"}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  <Badge
                    variant={
                      !r.success
                        ? "destructive"
                        : r.duration_ms > 30_000
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {(r.duration_ms / 1000).toFixed(1)}s
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function formatRangeShort(sinceIso: string, untilIso: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return `${fmt(sinceIso)} → ${fmt(untilIso)}`;
}
