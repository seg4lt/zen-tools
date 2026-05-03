/**
 * API Stats tab — split 50/50 between two panels:
 *
 *   • AI runs        diagnostic checkpoint for "did Settings actually
 *                    propagate?". Every `engine.ai_summary()`
 *                    invocation pushes a record (provider, resolved
 *                    model, repo, date range, duration, success,
 *                    commit count, cost) into a 200-entry rolling log
 *                    on the engine.
 *   • gh CLI calls   live view of every `gh` invocation made by the
 *                    other tabs.
 *
 * Each panel takes half the vertical space and scrolls internally,
 * so the page header stays put and the user can scan both logs
 * without one drowning the other. No sticky table heads (we already
 * bound the scroll area), no transparent page header (was bleeding
 * the tab content through during scroll).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Label } from "@zen-tools/ui";
import { Switch } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  prmasterTauri,
  type AiRunRecord,
  type GhCall,
  type ModelUsageEntry,
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
      {/* Solid card background — was `bg-card/40` and the
          half-transparency let the panel rows scroll up *behind* the
          page header, which read as a visual glitch. */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card px-4">
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

      {/* Two equal-height panels, each scrolling internally. Using
          `grid grid-rows-2` gives a clean 50/50 split with `min-h-0`
          on each row so flex/grid children can actually shrink past
          their content height. */}
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-2 bg-muted/20 p-2">
        <AiRunsPanel runs={aiRuns} />
        <GhCallsPanel calls={calls} />
      </div>
    </div>
  );
}

function AiRunsPanel({ runs }: { runs: AiRunRecord[] }) {
  return (
    <Panel className="flex min-h-0 flex-col">
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-card">
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
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {r.model ?? (
                          <span
                            className="italic text-muted-foreground"
                            title={
                              "No --model flag was passed; the CLI used its " +
                              "own default. Pick a model in Settings → AI Model."
                            }
                          >
                            (provider default)
                          </span>
                        )}
                      </span>
                      {r.model_usage && r.model_usage.length > 0 && (
                        <ModelUsageBreakdown entries={r.model_usage} />
                      )}
                    </div>
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
        </div>
      )}
    </Panel>
  );
}

function GhCallsPanel({ calls }: { calls: GhCall[] }) {
  if (calls.length === 0) {
    return (
      <Panel className="flex min-h-0 flex-col border-dashed">
        <PanelContent className="my-auto flex flex-col items-center gap-1.5 py-6 text-center text-xs text-muted-foreground">
          <p>No `gh` calls yet.</p>
          <p>
            Switch to another tab and trigger a refresh — calls show up here
            in real time.
          </p>
        </PanelContent>
      </Panel>
    );
  }
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader>
        <PanelTitle>gh CLI calls</PanelTitle>
        <span className="text-[10px] text-muted-foreground">
          {calls.length} total
        </span>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-card">
            <tr className="border-b text-left text-[10px] tracking-wide text-muted-foreground uppercase">
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="w-full px-2 py-1.5 font-medium">Command</th>
              <th className="px-2 py-1.5 text-right font-medium">Duration</th>
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
                  <span className={cn(!call.success && "text-destructive")}>
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
      </div>
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

/**
 * Per-model token-usage breakdown. Renders one chip per model the
 * provider's CLI reported, sorted by output tokens (the "real answer"
 * model first; the small Haiku routing model trails behind).
 *
 * The most common confusion this resolves: Claude Code uses Haiku
 * internally for tool selection / prompt routing **even when you ask
 * for Sonnet or Opus**. The CLI's JSON output names every model that
 * consumed tokens, so seeing Haiku alongside Sonnet here is normal —
 * the tooltip on each chip clarifies what each line means.
 */
function ModelUsageBreakdown({ entries }: { entries: ModelUsageEntry[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map((e, i) => {
        const isRouting =
          /haiku/i.test(e.model) &&
          (e.output_tokens ?? 0) <
            Math.max(...entries.map((m) => m.output_tokens ?? 0), 1) / 4;
        const inTok = e.input_tokens ?? 0;
        const outTok = e.output_tokens ?? 0;
        const tip = [
          e.model,
          `in ${inTok.toLocaleString()} / out ${outTok.toLocaleString()}`,
          isRouting
            ? "small model — used by Claude Code for internal routing / classification"
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <span
            key={`${e.model}-${i}`}
            title={tip}
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1 py-px text-[9px] font-mono",
              isRouting
                ? "border-muted-foreground/20 bg-muted/40 text-muted-foreground"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
          >
            <span className="truncate max-w-[160px]">{e.model}</span>
            <span className="opacity-70">
              {formatTokens(inTok + outTok)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}t`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}kt`;
  return `${Math.round(n / 1000)}kt`;
}
