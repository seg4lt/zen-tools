/**
 * Toolbar with the Run button + dialect badge + last-query timing.
 */

import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextPicker } from "./context-picker";
import type { DbConnectionPrefs, DbQueryResult } from "../lib/tauri";

interface RunToolbarProps {
  connection: DbConnectionPrefs | null;
  isConnected: boolean;
  isRunning: boolean;
  results: DbQueryResult[] | null;
  error: string | null;
  onRun: () => void;
}

export function RunToolbar({
  connection,
  isConnected,
  isRunning,
  results,
  error,
  onRun,
}: RunToolbarProps) {
  const totalMs =
    results?.reduce((acc, r) => acc + (r.durationMs ?? 0), 0) ?? null;
  const lastResult = results?.[results.length - 1] ?? null;

  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
      <Button
        variant="ghost"
        size="sm"
        onClick={onRun}
        disabled={!isConnected || isRunning}
        className="h-6 gap-1 px-1.5 text-[11px]"
        title="Run (⌘↵)"
      >
        {isRunning ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Play className="size-3" />
        )}
        Run
        <span className="ml-1 text-[10px] text-muted-foreground/70">⌘↵</span>
      </Button>

      {connection && (
        <span className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {connection.driver}
        </span>
      )}

      {connection && (
        <ContextPicker connection={connection} isConnected={isConnected} />
      )}

      <span className="flex-1" />

      {error && (
        <span className="truncate text-red-500" title={error}>
          {error}
        </span>
      )}

      {!error && totalMs !== null && (
        <span className="text-muted-foreground">
          {results!.length} stmt{results!.length === 1 ? "" : "s"} •{" "}
          {totalMs} ms
          {lastResult && lastResult.rows.length > 0 && (
            <> • {lastResult.rows.length} row{lastResult.rows.length === 1 ? "" : "s"}</>
          )}
        </span>
      )}
    </div>
  );
}
