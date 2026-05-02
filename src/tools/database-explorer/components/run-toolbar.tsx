/**
 * Toolbar with the Run buttons + dialect badge + last-query timing.
 *
 * Two run buttons: **Run** (cursor / selection) and **Run with plan**
 * (same target, but routed through `db_explain_query` so the result
 * tab opens the perf visualizer instead of the data grid). An
 * **Auto-EXPLAIN** toggle pill on the right makes every regular Run
 * also fire `db_explain_query` in the background, adding a Plan tab
 * next to the data tab automatically.
 */

import { Activity, Loader2, Play, PlaySquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogsButton } from "./logs-button";
import type { DbConnectionPrefs } from "../lib/tauri";
import type { ResultTab } from "../store/db-explorer-store";

interface RunToolbarProps {
  connection: DbConnectionPrefs | null;
  isConnected: boolean;
  isRunning: boolean;
  results: ResultTab[] | null;
  error: string | null;
  /** Run statement at cursor (or selection if there is one). */
  onRun: () => void;
  /** Run every statement in the buffer. */
  onRunAll: () => void;
  /** Run cursor / selection through `db_explain_query` and open the
   * perf visualizer in the result pane. Same target shape as
   * `onRun`. */
  onRunWithPlan: () => void;
  /** Whether auto-EXPLAIN is on for the active connection. */
  autoExplain: boolean;
  /** Toggle the auto-EXPLAIN flag for the active connection. */
  onToggleAutoExplain: () => void;
  /**
   * Whether "Run with plan" runs `EXPLAIN ANALYZE` (executes the
   * query, captures actual rows / timing / buffers) or plan-only
   * `EXPLAIN` (estimates only — no execution, safe on DML).
   * Defaults to `true` upstream.
   */
  analyzeOnExplain: boolean;
  /** Flip the analyze-on-explain flag for the active connection. */
  onToggleAnalyzeOnExplain: () => void;
}

export function RunToolbar({
  connection,
  isConnected,
  isRunning,
  results,
  error,
  onRun,
  onRunAll,
  onRunWithPlan,
  autoExplain,
  onToggleAutoExplain,
  analyzeOnExplain,
  onToggleAnalyzeOnExplain,
}: RunToolbarProps) {
  // Roll up timing across data + plan tabs so the right-hand summary
  // still works after the ResultTab discriminated-union refactor.
  const totalMs =
    results?.reduce(
      (acc, r) =>
        acc + (r.kind === "data" ? r.data.durationMs : r.explain.durationMs),
      0,
    ) ?? null;
  const lastDataTab = results
    ?.slice()
    .reverse()
    .find((r) => r.kind === "data");
  const lastDataRows =
    lastDataTab && lastDataTab.kind === "data" ? lastDataTab.data.rows.length : 0;

  return (
    // Toolbar surface: explicitly `bg-background` so it reads as a
    // "raised" strip between the deeper-tinted connection tabs above
    // and the editor below. The thin separators (`border-r border-
    // border/40`) carve the row into logical groups — Run actions,
    // Plan actions, Connection context, status — instead of one long
    // chain where everything blurs together.
    <div className="flex items-center gap-1.5 border-b border-border bg-background px-3 py-1.5 text-xs">
      {/* Group 1 — Run actions. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRun}
        disabled={!isConnected || isRunning}
        className="h-6 gap-1 px-1.5 text-[11px]"
        title="Run statement at cursor (or selection)"
      >
        {isRunning ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Play className="size-3" />
        )}
        Run
        <span className="ml-1 text-[10px] text-muted-foreground/70">⌘↵</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRunAll}
        disabled={!isConnected || isRunning}
        className="h-6 gap-1 px-1.5 text-[11px]"
        title="Run every statement in the file"
      >
        <PlaySquare className="size-3" />
        Run all
      </Button>

      <ToolbarSep />

      {/* Group 2 — Plan actions. The two pieces (button + actuals
          toggle) belong together: the toggle decides which flavour
          of EXPLAIN the button runs. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRunWithPlan}
        disabled={!isConnected || isRunning}
        className="h-6 gap-1 px-1.5 text-[11px]"
        title={
          analyzeOnExplain
            ? "Run the query and capture EXPLAIN ANALYZE (actual rows, timing, buffers). The query executes — DML modifies data."
            : "Capture EXPLAIN only (planner estimates). The query is NOT executed — safe on UPDATE / DELETE / INSERT."
        }
      >
        <Activity className="size-3" />
        {analyzeOnExplain ? "Run with plan" : "Plan only"}
      </Button>
      <label
        className={
          "flex h-6 cursor-pointer items-center gap-1 rounded border px-1.5 text-[10px] uppercase tracking-wide transition " +
          (analyzeOnExplain
            ? "border-primary/60 bg-primary/10 text-primary"
            : "border-border/60 bg-background text-muted-foreground hover:border-primary/40")
        }
        title={
          analyzeOnExplain
            ? "On: Run with plan executes the query and reports actual rows + timing + buffers (Postgres ANALYZE / MSSQL STATISTICS XML)."
            : "Off: Run with plan returns the planner's estimated plan only — the query is not executed. Safe on destructive statements."
        }
      >
        <input
          type="checkbox"
          className="size-3 cursor-pointer"
          checked={analyzeOnExplain}
          onChange={onToggleAnalyzeOnExplain}
          disabled={!isConnected}
        />
        actuals
      </label>
      {/* Auto-EXPLAIN: compact icon-pill — full label "Auto-EXPLAIN:
          off" was wrapping into 3 lines on narrow viewports. The
          tooltip carries the long form. */}
      {connection && (
        <button
          type="button"
          onClick={onToggleAutoExplain}
          disabled={!isConnected}
          className={
            "flex h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] uppercase tracking-wide transition " +
            (autoExplain
              ? "border-primary/60 bg-primary/10 text-primary"
              : "border-border/60 bg-background text-muted-foreground hover:border-primary/40")
          }
          title={
            autoExplain
              ? "Auto-EXPLAIN is on — every Run also captures a plan tab next to the data tab"
              : "Auto-EXPLAIN is off — click to make every Run also capture a plan"
          }
        >
          <Activity className="size-3" />
          Auto {autoExplain ? "ON" : "OFF"}
        </button>
      )}

      {/* DB / schema picker lives on the connection-tabs row now,
          next to the connection picker — same row, same identity.
          Toolbar stays purely action-focused. */}

      <span className="flex-1" />

      {error && (
        <span className="truncate text-red-500" title={error}>
          {error}
        </span>
      )}

      {!error && totalMs !== null && results && (
        <span className="text-muted-foreground">
          {results.length} tab{results.length === 1 ? "" : "s"} • {totalMs} ms
          {lastDataRows > 0 && (
            <> • {lastDataRows} row{lastDataRows === 1 ? "" : "s"}</>
          )}
        </span>
      )}

      <LogsButton />
    </div>
  );
}

/**
 * One-pixel vertical hairline used between toolbar groups. The
 * subtle margin-x keeps it from kissing its neighbouring controls,
 * and `bg-border/60` matches the editor + tab-strip seam colour so
 * the rule reads as a continuation of the surrounding chrome
 * rather than a heavy divider.
 */
function ToolbarSep() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border/60" />;
}
