/**
 * Virtualised results grid for a single query result.
 *
 * Layout: header and body live as **siblings** inside the scroll
 * container, both with explicit `width: totalWidth`. Sticky header
 * pins to top during vertical scroll; horizontal scroll moves both
 * together. Avoiding a wrapper around the body means the absolute-row
 * pattern doesn't fight with parent flex sizing.
 */

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cellToString, type DbCell, type DbQueryResult } from "../lib/tauri";

interface ResultsGridProps {
  result: DbQueryResult;
}

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const MIN_COL_WIDTH = 96;
const MAX_COL_WIDTH = 480;
const CHAR_PX = 7.6; // approx mono char width @ text-xs

export function ResultsGrid({ result }: ResultsGridProps) {
  // Pre-compute per-column widths from header + sample of rows. Cheap:
  // scan the first 50 rows so wide values dominate sizing without
  // walking every cell.
  const columnWidths = useMemo(() => {
    const sample = result.rows.slice(0, 50);
    return result.columns.map((col, idx) => {
      let maxLen = col.name.length + col.typeName.length + 2;
      for (const row of sample) {
        const cell = row[idx];
        if (!cell) continue;
        const s = cell.kind === "null" ? 4 : cellToString(cell).length;
        if (s > maxLen) maxLen = s;
      }
      const px = Math.round(maxLen * CHAR_PX) + 24;
      return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, px));
    });
  }, [result.columns, result.rows]);

  const totalWidth = columnWidths.reduce((a, b) => a + b, 0);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualiser = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Status row when the statement returned no columns (DDL/DML/etc).
  if (result.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Statement OK
        {result.rowsAffected !== null && (
          <>
            {" "}
            · {result.rowsAffected} row
            {result.rowsAffected === 1 ? "" : "s"} affected
          </>
        )}
        <span className="ml-2 opacity-60">({result.durationMs} ms)</span>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="relative h-full w-full overflow-auto font-mono text-xs"
    >
      {/* Header — sticky top, sized to totalWidth. */}
      <div
        className="sticky top-0 z-10 flex border-b border-border/60 bg-background"
        style={{ width: totalWidth, height: HEADER_HEIGHT }}
      >
        {result.columns.map((col, idx) => (
          <div
            key={idx}
            className="flex shrink-0 items-center gap-1 truncate border-r border-border/40 px-2 py-1 text-left"
            style={{ width: columnWidths[idx] }}
            title={`${col.name} : ${col.typeName}`}
          >
            <span className="truncate font-medium text-foreground">
              {col.name}
            </span>
            <span className="shrink-0 text-[10px] uppercase text-muted-foreground/70">
              {col.typeName}
            </span>
          </div>
        ))}
      </div>

      {/* Body — explicit width so horizontal scroll engages even when
          rows are absolutely positioned. */}
      <div
        style={{
          position: "relative",
          width: totalWidth,
          height: virtualiser.getTotalSize(),
        }}
      >
        {virtualiser.getVirtualItems().map((vRow) => {
          const row = result.rows[vRow.index];
          return (
            <div
              key={vRow.index}
              className="absolute left-0 flex border-b border-border/30 hover:bg-muted/40"
              style={{
                top: 0,
                width: totalWidth,
                height: vRow.size,
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {row.map((cell, idx) => (
                <div
                  key={idx}
                  className="shrink-0 truncate border-r border-border/30 px-2 py-1"
                  style={{ width: columnWidths[idx] }}
                  title={cellOrEmpty(cell)}
                >
                  {cell.kind === "null" ? (
                    <span className="italic text-muted-foreground/60">
                      NULL
                    </span>
                  ) : (
                    cellToString(cell)
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function cellOrEmpty(c: DbCell): string {
  return c.kind === "null" ? "" : cellToString(c);
}
