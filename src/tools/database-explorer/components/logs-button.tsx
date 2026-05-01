/**
 * Logs button + slide-in Sheet panel showing every query that has run
 * this session. Lives in the run toolbar so it's always reachable; the
 * sheet itself can stay open while the user keeps editing.
 *
 * Each entry shows:
 *   - status pip (green ok / red error)
 *   - timestamp (HH:MM:SS)
 *   - connection name + driver
 *   - SQL (mono, line-clamped — full text in the title attribute)
 *   - duration / row count, or error message
 *
 * Clear button wipes the in-memory log; reload the app to also reset
 * the working buffers.
 */

import { useState } from "react";
import { ScrollText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useDbExplorerStore } from "../store/db-explorer-store";
import type { QueryLogEntry } from "../store/db-explorer-store";

export function LogsButton() {
  const { state, dispatch } = useDbExplorerStore();
  const [open, setOpen] = useState(false);
  const count = state.logs.length;
  const hasError = state.logs.some((l) => l.status === "error");

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          title="Query log"
        >
          <ScrollText className="size-3" />
          Logs
          {count > 0 && (
            <span
              className={cn(
                "ml-1 rounded px-1 text-[10px]",
                hasError
                  ? "bg-red-500/15 text-red-600"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="!max-w-xl"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="text-sm">Query log</SheetTitle>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={() => dispatch({ type: "clear-logs" })}
              disabled={count === 0}
              title="Clear log"
            >
              <Trash2 className="size-3" />
              Clear
            </Button>
          </div>
          <SheetDescription className="text-[11px]">
            {count === 0
              ? "Nothing has run yet."
              : `${count} ${count === 1 ? "entry" : "entries"} (newest first, capped at 500).`}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {count === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Run a query to start logging.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {state.logs.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function LogRow({ entry }: { entry: QueryLogEntry }) {
  const isError = entry.status === "error";
  return (
    <li
      className={cn(
        "rounded border px-2 py-1.5 text-[11px] transition",
        isError
          ? "border-red-500/30 bg-red-500/5"
          : "border-border/60 bg-background hover:bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <span
          className={cn(
            "inline-block size-1.5 shrink-0 rounded-full",
            isError ? "bg-red-500" : "bg-emerald-500",
          )}
        />
        <span className="font-mono">{formatTime(entry.ts)}</span>
        <span className="truncate" title={entry.connectionName}>
          {entry.connectionName}
        </span>
        <span className="font-mono uppercase opacity-70">
          {entry.driver}
        </span>
        <span className="ml-auto font-mono">
          {isError
            ? "ERROR"
            : entry.statementCount > 1
              ? `${entry.statementCount} stmts · ${entry.durationMs} ms`
              : `${entry.durationMs} ms`}
        </span>
      </div>
      <pre
        className="mt-1 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground"
        title={entry.sql}
      >
        {entry.sql}
      </pre>
      {entry.message && (
        <div
          className="mt-1 text-[11px] text-red-600"
          title={entry.message}
        >
          {entry.message}
        </div>
      )}
    </li>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
