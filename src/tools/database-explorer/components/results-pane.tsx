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
import { AlertCircle, Copy, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ResultsGrid } from "./results-grid";
import { ExplainViews } from "./explain-views";
import {
  useDbExplorerStore,
  type ResultTab,
} from "../store/db-explorer-store";
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

  // Error card takes precedence over an empty-state. If there are
  // also previous results, we still surface the error on top so the
  // user can read it without scrolling/clicking — running a bad
  // query right after a good one shouldn't bury the diagnostic.
  if (error) {
    return <ErrorCard message={error} hasPriorResults={!!results?.length} />;
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
      />
      {/* `relative + min-w-0 + overflow-hidden` clips the grid to the
          parent's width even when its inner header/body are wider. The
          grid's own `overflow-auto` then provides the scrollbar. */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {active.kind === "data" ? (
          <ResultsGrid result={active.data} />
        ) : (
          <ExplainViews
            connectionId={connectionId}
            explain={active.explain}
          />
        )}
      </div>
    </div>
  );
}

interface TabStripProps {
  results: ResultTab[];
  activeIdx: number;
  maximized: boolean;
  onToggleMaximize: () => void;
  onSelect: (idx: number) => void;
  onClose: (idx: number) => void;
}

function TabStrip({
  results,
  activeIdx,
  maximized,
  onToggleMaximize,
  onSelect,
  onClose,
}: TabStripProps) {
  return (
    <div className="flex shrink-0 items-stretch border-b border-border/60 bg-muted/20">
      {/* Scrollable tab strip — narrow viewports overflow-scroll
          horizontally without pushing the maximize button off. */}
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1">
        {results.map((r, idx) => {
          const isActive = idx === activeIdx;
          return (
            <div
              key={idx}
              className={cn(
                "group flex shrink-0 items-center gap-1 rounded-t px-2 py-1 text-[11px] transition",
                isActive
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <button
                type="button"
                className="flex items-center gap-1"
                onClick={() => onSelect(idx)}
                title={
                  r.kind === "data" ? r.data.statement : r.explain.statement
                }
              >
                <span className="max-w-[12ch] truncate font-mono">
                  {labelForTab(idx, r)}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  {summaryFor(r)}
                </span>
              </button>
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
  if (r.kind === "explain") {
    return summaryForExplain(r.explain);
  }
  return summaryForData(r.data);
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
