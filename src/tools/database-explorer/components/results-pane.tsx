/**
 * Multi-result tab strip + active-tab grid.
 *
 * Each statement in a Run produces one tab. Click a tab to view its
 * grid; click the X to close it (the rest stay). New runs replace the
 * tab set.
 *
 * Errors take over the pane completely — the run-toolbar still shows a
 * truncated red one-liner, but the actual diagnostic surface is here:
 * full-text monospaced, scrollable, never clipped.
 */

import { useState } from "react";
import {
  AlertCircle,
  Copy,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Square,
  Table as TableIcon,
  X,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { ResultsGrid } from "./results-grid";
import { ExplainViews } from "./explain-views";
import { LocksView } from "./locks-view";
import {
  useDbExplorerStore,
  type ResultTab,
} from "../store/db-explorer-store";
import { useDbQuery } from "../hooks/use-db-query";
import type { DbExplainResult, DbQueryResult } from "../lib/tauri";

interface ResultsPaneProps {
  connectionId: string | null;
  results: ResultTab[] | null;
  /**
   * Latest error for the active connection, or `null` when the last
   * run succeeded. When set, the pane renders a full-text error card
   * instead of (or above) the result tabs.
   */
  error: string | null;
  /** True when the pane has taken over the centre column. */
  maximized: boolean;
  /** Flip `maximized`. The icon on each tab calls this. */
  onToggleMaximize: () => void;
}

export function ResultsPane({
  connectionId,
  results,
  error,
  maximized,
  onToggleMaximize,
}: ResultsPaneProps) {
  const { state, dispatch } = useDbExplorerStore();
  const { stopQuery } = useDbQuery();

  // Error card takes precedence over an empty-state ONLY when there
  // are no per-tab results — per-tab errors live on their own tab now,
  // so a stale toolbar error one-liner shouldn't blanket the pane.
  if (error && (!results || results.length === 0)) {
    return <ErrorCard message={error} hasPriorResults={false} />;
  }

  if (!connectionId || !results || results.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Run a query to see results.
      </div>
    );
  }

  const activeIdx = Math.min(
    state.activeResultIndexByConnection[connectionId] ?? 0,
    results.length - 1,
  );
  const active = results[activeIdx];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <TabStrip
        results={results}
        activeIdx={activeIdx}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
        onSelect={(idx) =>
          dispatch({
            type: "set-active-result-index",
            id: connectionId,
            index: idx,
          })
        }
        onClose={(idx) =>
          dispatch({ type: "close-result-tab", id: connectionId, index: idx })
        }
        onStop={(tabId) => void stopQuery(tabId)}
      />
      {/* `relative + min-w-0 + overflow-hidden` clips the grid to the
          parent's width even when its inner header/body are wider. The
          grid's own `overflow-auto` then provides the scrollbar. */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <ActiveTabBody
          tab={active}
          connectionId={connectionId}
          onStop={() => void stopQuery(active.id)}
        />
      </div>
    </div>
  );
}

/**
 * Renders the body of whichever tab is currently selected. Splits on
 * the tab `kind` discriminator so each lifecycle state gets its own
 * affordance:
 *
 *   - `running`   — full-pane spinner + Stop button. Mirrors the
 *                   per-tab Stop on the strip so the user can hit
 *                   either.
 *   - `data`      — the existing grid (with optional Locks sub-tab).
 *   - `explain`   — the perf visualizer.
 *   - `error`     — full-fidelity error card on a per-tab basis.
 *   - `cancelled` — gentle "Cancelled by user" empty-state.
 */
function ActiveTabBody({
  tab,
  connectionId,
  onStop,
}: {
  tab: ResultTab;
  connectionId: string;
  onStop: () => void;
}) {
  switch (tab.kind) {
    case "running":
      return <RunningTabBody tab={tab} onStop={onStop} />;
    case "data":
      return <DataResultView result={tab.data} />;
    case "explain":
      return (
        <ExplainViews connectionId={connectionId} explain={tab.explain} />
      );
    case "error":
      return <ErrorCard message={tab.error} hasPriorResults={false} />;
    case "cancelled":
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-muted-foreground">
          <span className="font-medium">Cancelled</span>
          <span>The query was stopped before it finished.</span>
        </div>
      );
  }
}

/** Full-pane "running" placeholder. The Stop button is duplicated here
 * (also lives on the tab strip) because users tend to look at the body
 * of the active tab when they realise they want to abort. */
function RunningTabBody({
  tab,
  onStop,
}: {
  tab: Extract<ResultTab, { kind: "running" }>;
  onStop: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-muted-foreground">
      <Loader2 className="size-5 animate-spin text-primary/70" />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">Running…</span>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          {tab.sqlPreview || "(empty)"}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onStop}
        className="h-7 gap-1.5 px-2 text-[11px]"
      >
        <Square className="size-3 fill-current" />
        Stop query
      </Button>
    </div>
  );
}

/**
 * Wrapper around `ResultsGrid` that surfaces a Data / Locks sub-tab
 * strip when the result carries lock telemetry (i.e. the user
 * clicked "Run with locks"). Without locks, this is a transparent
 * pass-through to the grid — zero visual change to the existing
 * Run path.
 */
function DataResultView({ result }: { result: import("../lib/tauri").DbQueryResult }) {
  const [view, setView] = useState<"data" | "locks">("data");
  if (!result.locks) {
    return <ResultsGrid result={result} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-muted/30 px-2 py-1 text-[11px]">
        <SubTabButton
          active={view === "data"}
          onClick={() => setView("data")}
          icon={<TableIcon className="size-3" />}
          label="Data"
        />
        <SubTabButton
          active={view === "locks"}
          onClick={() => setView("locks")}
          icon={<Lock className="size-3" />}
          label="Locks"
        />
      </div>
      <div className="min-h-0 flex-1">
        {view === "data" ? (
          <ResultsGrid result={result} />
        ) : (
          <LocksView summary={result.locks} durationMs={result.durationMs} />
        )}
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 transition",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface TabStripProps {
  results: ResultTab[];
  activeIdx: number;
  maximized: boolean;
  onToggleMaximize: () => void;
  onSelect: (idx: number) => void;
  onClose: (idx: number) => void;
  /** Cancel the in-flight query backing the tab with this id.
   * Only fires when the tab's status is `running`. */
  onStop: (tabId: string) => void;
}

function TabStrip({
  results,
  activeIdx,
  maximized,
  onToggleMaximize,
  onSelect,
  onClose,
  onStop,
}: TabStripProps) {
  return (
    // `bg-muted/60` matches the connection-tab + editor-tab strip
    // vocabulary so the eye groups all three "tab rails" as the
    // same kind of surface — and the active tab's `bg-background`
    // visibly lifts up out of it, same lift as the other strips.
    <div className="flex shrink-0 items-stretch border-b border-border/60 bg-muted/60">
      {/* Scrollable tab strip — narrow viewports overflow-scroll
          horizontally without pushing the maximize button off. */}
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1">
        {results.map((r, idx) => {
          const isActive = idx === activeIdx;
          const isRunning = r.kind === "running";
          const isError = r.kind === "error";
          const isCancelled = r.kind === "cancelled";
          return (
            <div
              key={r.id}
              className={cn(
                "group flex shrink-0 items-center gap-1 rounded-t px-2 py-1 text-[11px] transition",
                isActive
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/50",
                isError && "text-destructive",
                isCancelled && "opacity-70",
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1"
                onClick={() => onSelect(idx)}
                title={r.sqlPreview || labelForTab(idx, r)}
              >
                {isRunning && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-primary/70" />
                )}
                <span className="max-w-[14ch] truncate font-mono">
                  {labelForTab(idx, r)}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  {summaryFor(r)}
                </span>
              </button>
              {isRunning ? (
                // Stop button replaces Close while running. Clicking
                // X on a running tab would just abandon the row,
                // leaving the backend query running silently — Stop
                // is what the user actually wants.
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-4 w-4 p-0 text-destructive opacity-100 hover:bg-destructive/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop(r.id);
                  }}
                  title="Stop query"
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-4 w-4 p-0 opacity-0 transition group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(idx);
                  }}
                  title="Close result"
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Always-visible global maximize toggle — pinned to the right
          end of the strip, outside the scrollable tabs container so
          it can't get lost behind a long row of tabs. */}
      <div className="flex shrink-0 items-center border-l border-border/60 px-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={onToggleMaximize}
          title={
            maximized ? "Restore split view" : "Maximize results pane"
          }
        >
          {maximized ? (
            <>
              <Minimize2 className="size-3" />
              Restore
            </>
          ) : (
            <>
              <Maximize2 className="size-3" />
              Maximize
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Full-fidelity error display. The toolbar shows a one-liner; this is
 * the place where the user actually reads the message.
 *
 * Renders the entire error message in a monospaced block with scroll
 * (long Postgres `syntax error … near "blah"` traces stay legible).
 * A copy button lifts the message to the clipboard for pasting into
 * a bug report or asking for help — losing the error to a re-run is
 * a frequent annoyance worth one button.
 */
function ErrorCard({
  message,
  hasPriorResults,
}: {
  message: string;
  hasPriorResults: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Soft-fail — clipboard access can be denied; the message is
      // still selectable in the rendered <pre>.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-destructive/5">
      <div className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2">
        <AlertCircle className="size-4 shrink-0 text-destructive" />
        <span className="font-semibold text-destructive">Query error</span>
        {hasPriorResults ? (
          <span className="ml-1 text-[11px] text-muted-foreground">
            (previous results discarded)
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopy}
          className="h-6 gap-1 px-2 text-[11px]"
          title="Copy full error to clipboard"
        >
          <Copy className="size-3" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        // Selectable, wraps long lines, scrolls vertically when the
        // message is taller than the pane. Monospace + slightly
        // larger leading so multi-line stack-trace-like errors
        // stay readable.
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-destructive"
      >
        {message}
      </pre>
    </div>
  );
}

function labelForTab(idx: number, r: ResultTab): string {
  if (r.kind === "explain") {
    return `PLAN #${idx + 1}`;
  }
  if (r.kind === "running" || r.kind === "error" || r.kind === "cancelled") {
    const keyword = firstSqlKeyword(r.sqlPreview);
    return keyword ? `${keyword} #${idx + 1}` : `Run #${idx + 1}`;
  }
  const keyword = firstSqlKeyword(r.data.statement);
  return keyword ? `${keyword} #${idx + 1}` : `Result ${idx + 1}`;
}

/**
 * Best-effort "what kind of statement is this?" label.
 *
 * The naive `split(/\s+/)[0]` we used before broke whenever the
 * statement was preceded by an SQL comment using box-drawing
 * characters (e.g. `-- ─────────…`) or non-breaking spaces — the
 * regex's `[\s/*-]+` prefix didn't strip those, so the first "word"
 * was a pile of dashes that the browser then tried to render in a
 * mismatched encoding (the famous `Â Â Â …` mojibake).
 *
 * Strip block + line comments, then grab the first ASCII alpha
 * identifier *anywhere* in what remains. That's what matters: SQL
 * keywords are always plain Latin letters.
 */
function firstSqlKeyword(sql: string): string | null {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* … */ block comments
    .replace(/--[^\n]*/g, ""); //        -- line comments
  const m = cleaned.match(/[A-Za-z][A-Za-z0-9_]*/);
  if (!m) return null;
  const word = m[0].toUpperCase();
  return word.length > 16 ? `${word.slice(0, 16)}…` : word;
}

function summaryFor(r: ResultTab): string {
  switch (r.kind) {
    case "explain":
      return summaryForExplain(r.explain);
    case "data":
      return summaryForData(r.data);
    case "running": {
      const elapsed = Math.max(0, Math.floor((Date.now() - r.startedAt) / 100) / 10);
      return `running · ${elapsed.toFixed(1)}s`;
    }
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}

function summaryForData(r: DbQueryResult): string {
  if (r.columns.length > 0) {
    return `${r.rows.length} row${r.rows.length === 1 ? "" : "s"} · ${r.durationMs} ms`;
  }
  if (r.rowsAffected !== null) {
    return `${r.rowsAffected} affected · ${r.durationMs} ms`;
  }
  return `OK · ${r.durationMs} ms`;
}

function summaryForExplain(r: DbExplainResult): string {
  return `${r.format.toUpperCase()} · ${r.durationMs} ms`;
}
