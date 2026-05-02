/**
 * Toolbar with the Run buttons + dialect badge + last-query timing.
 *
 * Two primary buttons — **Run** (cursor / selection) and **Run all**
 * (every statement in the buffer) — plus a single "**Run with…**"
 * split control that bundles the three opt-in execution modes
 * (Plan, Actuals, Locks) into one multi-select dropdown. The
 * checkboxes persist for the connection so power users only have to
 * pick their combo once per session.
 *
 * The Auto-EXPLAIN pill stays separate: it changes what the
 * **regular Run** button does (always-on plan piggyback), so it
 * doesn't belong inside the per-execution mode picker.
 */

import { Activity, ChevronDown, Loader2, Play, PlaySquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LogsButton } from "./logs-button";
import type { DbConnectionPrefs } from "../lib/tauri";
import type { ResultTab } from "../store/db-explorer-store";

/**
 * Set of opt-in modes selectable from the "Run with…" dropdown.
 * Multiple modes can be combined: e.g. `{ plan: true, locks: true }`
 * runs the query with both a captured EXPLAIN tab and a Locks
 * sub-tab on the data result.
 *
 * `actuals` is meaningful only when `plan` is on — it toggles
 * `EXPLAIN ANALYZE` (executes + captures actuals) vs plain
 * `EXPLAIN` (planner estimates, safe on DML). The dropdown
 * disables the Actuals checkbox when Plan is unchecked so the
 * combination stays intuitive.
 */
export interface RunModes {
  plan: boolean;
  actuals: boolean;
  locks: boolean;
}

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
  /**
   * Run cursor / selection with the modes the user has selected
   * in the "Run with…" dropdown. Implementations decide how to
   * combine the modes — the typical case is to run the query for
   * data (with `captureLocks` if `locks`) and, if `plan`, fire a
   * piggyback `db_explain_query` that appends a plan tab.
   */
  onRunWithModes: (modes: RunModes) => void;
  /** Currently-selected modes for the "Run with…" dropdown. */
  runModes: RunModes;
  /** Replace the current `RunModes` selection (e.g. checkbox toggle). */
  onChangeRunModes: (next: RunModes) => void;
  /** Whether auto-EXPLAIN is on for the active connection. */
  autoExplain: boolean;
  /** Toggle the auto-EXPLAIN flag for the active connection. */
  onToggleAutoExplain: () => void;
}

export function RunToolbar({
  connection,
  isConnected,
  isRunning,
  results,
  error,
  onRun,
  onRunAll,
  onRunWithModes,
  runModes,
  onChangeRunModes,
  autoExplain,
  onToggleAutoExplain,
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

  // Are *any* opt-in modes selected? Drives the "Run with…" button's
  // tone — when nothing is checked, clicking it is a no-op (so we
  // disable it instead of running the same query as plain Run).
  const anyModeOn = runModes.plan || runModes.locks;
  const modeChips = describeModes(runModes);

  return (
    // Toolbar surface: explicitly `bg-background` so it reads as a
    // "raised" strip between the deeper-tinted connection tabs above
    // and the editor below. The thin separators (`border-r border-
    // border/40`) carve the row into logical groups — Run actions,
    // Run-with picker, Auto-EXPLAIN pill, status — instead of one
    // long chain where everything blurs together.
    <div className="flex items-center gap-1.5 border-b border-border bg-background px-3 py-1.5 text-xs">
      {/* Group 1 — primary Run actions. */}
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

      {/* Group 2 — combined "Run with…" picker.
          Split-button pattern: clicking the body fires the run with
          the currently-selected modes, clicking the chevron opens
          the multi-select. The chips on the body summarise the
          current selection so the user can see at a glance whether
          clicking will get them Plan, Locks, or both. */}
      <div className="inline-flex items-stretch overflow-hidden rounded border border-border/60">
        <button
          type="button"
          onClick={() => onRunWithModes(runModes)}
          disabled={!isConnected || isRunning || !anyModeOn}
          className={cn(
            "flex h-6 items-center gap-1 px-1.5 text-[11px] transition",
            anyModeOn
              ? "bg-primary/5 text-foreground hover:bg-primary/10"
              : "bg-background text-muted-foreground",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
          title={
            anyModeOn
              ? `Run with: ${modeChips.join(" + ")}`
              : "Pick at least one mode from the dropdown"
          }
        >
          <Activity className="size-3" />
          <span>Run with</span>
          {modeChips.length > 0 && (
            <span className="ml-1 inline-flex gap-1">
              {modeChips.map((m) => (
                <span
                  key={m}
                  className="rounded bg-primary/15 px-1 font-mono text-[10px] uppercase tracking-wide text-primary"
                >
                  {m}
                </span>
              ))}
            </span>
          )}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={!isConnected}
              className={cn(
                "flex h-6 items-center border-l border-border/60 px-1 text-muted-foreground transition",
                "hover:bg-muted/60 hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
              title="Pick which modes to run with"
              aria-label="Choose run modes"
            >
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Run with…
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={runModes.plan}
              onCheckedChange={(v) =>
                onChangeRunModes({
                  ...runModes,
                  plan: !!v,
                  // Reset actuals to a sensible default when the
                  // user flips Plan on (most users want actuals
                  // when they ask for a plan); leave as-is when
                  // turning Plan off so re-enabling restores the
                  // previous Actuals choice.
                  actuals: v ? runModes.actuals || true : runModes.actuals,
                })
              }
              onSelect={(e) => e.preventDefault()}
            >
              <div className="flex flex-col">
                <span className="font-medium">Plan</span>
                <span className="text-[10px] text-muted-foreground">
                  Adds a plan tab via{" "}
                  <code className="font-mono">EXPLAIN</code>
                </span>
              </div>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={runModes.actuals}
              disabled={!runModes.plan}
              onCheckedChange={(v) =>
                onChangeRunModes({ ...runModes, actuals: !!v })
              }
              onSelect={(e) => e.preventDefault()}
              className="pl-8"
            >
              <div className="flex flex-col">
                <span className="font-medium">Actuals</span>
                <span className="text-[10px] text-muted-foreground">
                  <code className="font-mono">EXPLAIN ANALYZE</code> —
                  executes the query for real timings + buffers.
                  Skips on destructive DML when off.
                </span>
              </div>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={runModes.locks}
              onCheckedChange={(v) =>
                onChangeRunModes({ ...runModes, locks: !!v })
              }
              onSelect={(e) => e.preventDefault()}
            >
              <div className="flex flex-col">
                <span className="font-medium">Locks</span>
                <span className="text-[10px] text-muted-foreground">
                  Sidecar polls{" "}
                  <code className="font-mono">pg_locks</code> /{" "}
                  <code className="font-mono">sys.dm_tran_locks</code>
                  ; adds a Locks sub-tab.
                </span>
              </div>
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Auto-EXPLAIN: compact icon-pill — full label "Auto-EXPLAIN:
          off" was wrapping into 3 lines on narrow viewports. The
          tooltip carries the long form. Stays separate from the
          Run-with picker because it modifies what regular Run does
          rather than being a per-execution opt-in. */}
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
 * Render a `RunModes` selection as the short chip list shown on
 * the split-button body. Examples:
 *   {plan, actuals}          → ["PLAN", "ACTUALS"]
 *   {plan} (no actuals)      → ["PLAN"]   (planner estimates only)
 *   {locks}                  → ["LOCKS"]
 *   {plan, actuals, locks}   → ["PLAN", "ACTUALS", "LOCKS"]
 */
function describeModes(m: RunModes): string[] {
  const out: string[] = [];
  if (m.plan) {
    out.push("PLAN");
    if (m.actuals) out.push("ACTUALS");
  }
  if (m.locks) out.push("LOCKS");
  return out;
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
