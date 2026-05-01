/**
 * Multi-result tab strip + active-tab grid.
 *
 * Each statement in a Run produces one tab. Click a tab to view its
 * grid; click the X to close it (the rest stay). New runs replace the
 * tab set.
 */

import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ResultsGrid } from "./results-grid";
import { useDbExplorerStore } from "../store/db-explorer-store";
import type { DbQueryResult } from "../lib/tauri";

interface ResultsPaneProps {
  connectionId: string | null;
  results: DbQueryResult[] | null;
  /** True when the pane has taken over the centre column. */
  maximized: boolean;
  /** Flip `maximized`. The icon on each tab calls this. */
  onToggleMaximize: () => void;
}

export function ResultsPane({
  connectionId,
  results,
  maximized,
  onToggleMaximize,
}: ResultsPaneProps) {
  const { state, dispatch } = useDbExplorerStore();

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
        <ResultsGrid result={active} />
      </div>
    </div>
  );
}

interface TabStripProps {
  results: DbQueryResult[];
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
                title={r.statement}
              >
                <span className="font-mono">{labelForTab(idx, r)}</span>
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

function labelForTab(idx: number, r: DbQueryResult): string {
  // Use the first SQL keyword as a quick visual marker, falling back
  // to "Result N".
  const keyword = r.statement
    .replace(/^[\s/*-]+/, "")
    .split(/\s+/)[0]
    ?.toUpperCase();
  return keyword ? `${keyword} #${idx + 1}` : `Result ${idx + 1}`;
}

function summaryFor(r: DbQueryResult): string {
  if (r.columns.length > 0) {
    return `${r.rows.length} row${r.rows.length === 1 ? "" : "s"} · ${r.durationMs} ms`;
  }
  if (r.rowsAffected !== null) {
    return `${r.rowsAffected} affected · ${r.durationMs} ms`;
  }
  return `OK · ${r.durationMs} ms`;
}
