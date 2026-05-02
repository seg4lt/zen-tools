/**
 * Bottom status bar.
 *
 * Replaces the old `FileFooter` and absorbs its job (open-file path
 * + dirty marker + ⌘S hint) while adding a left-aligned "where am
 * I" chunk that names the active connection in the same vocabulary
 * used by the connection-tab strip — driver-coloured database glyph
 * + connection name + `db · schema`. Together with the editor tab
 * strip, the status bar closes the "I don't know what I'm querying"
 * gap without claiming any new vertical space than `FileFooter` did.
 *
 * Right edge surfaces a compact cache-progress chip when a job is
 * running, otherwise nothing. The `SchemaProgressIndicator` is the
 * canonical source for that data; the status bar only mirrors a
 * one-line summary so the user has a deterministic "is anything
 * happening?" anchor.
 */
import { useEffect, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  awaitProgressSubscribed,
  readJobs,
  subscribeProgress,
} from "../lib/schema-progress";
import { useDbExplorerStore } from "../store/db-explorer-store";
import type { SchemaCacheProgressEvent } from "../lib/tauri";
import type { DbConnectionPrefs } from "../lib/tauri";

/**
 * Mirrors `connection-tabs.tsx`'s palette so the active connection
 * shows the same hue everywhere it appears (tab top bar, tab icon,
 * status bar dot, status bar icon).
 */
function driverAccent(driver: DbConnectionPrefs["driver"] | undefined): string {
  switch (driver) {
    case "postgres":
      return "var(--chart-2)";
    case "mssql":
      return "var(--chart-1)";
    default:
      return "var(--muted-foreground)";
  }
}

export function StatusBar() {
  const { state } = useDbExplorerStore();

  const activeId = state.activeConnectionId;
  const active = activeId
    ? state.connections.find((c) => c.id === activeId) ?? null
    : null;
  const isConnected = activeId
    ? state.status[activeId] === "connected"
    : false;
  const accent = driverAccent(active?.driver);
  // The active database / schema we'd send the next query against.
  // Echoed here so the user can see at a glance what context the
  // run will use — but the *picker* lives in the toolbar where
  // it sits next to Run.
  const activeDb = activeId
    ? state.activeDbByConnection[activeId] ?? active?.database ?? null
    : null;
  const activeSchema = activeId
    ? state.activeSchemaByConnection[activeId] || null
    : null;

  const path = state.selectedFilePath;
  const dirty = path ? !!state.dirtyByPath[path] : false;

  return (
    // Surface paired with the side rails (`bg-muted/40`) so the
    // status bar reads as the bottom edge of the chrome — same
    // visual register as a desktop-app status bar. Border on top
    // gives the seam separating it from the results pane.
    <div className="flex shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
      {/* Left chunk — connection identity. Read-only summary; the
          connection-tab strip up top is the canonical surface for
          switching / adding. Keeping this chip clickless avoids
          duplicating the same affordance in two places (the
          previous popover trigger here was confusing because the
          tabs already do the same job and people couldn't tell
          which was authoritative). */}
      <span
        className={cn(
          "flex items-center gap-1.5 rounded px-1.5 py-0.5",
          !active && "opacity-60",
        )}
        title={active ? active.name : "No active connection"}
      >
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{
            background: isConnected ? accent : "var(--muted-foreground)",
          }}
        />
        <Database
          className="size-3 shrink-0"
          style={{ color: isConnected ? accent : undefined }}
        />
        <span className="font-mono">
          {active ? active.name : "no connection"}
        </span>
      </span>

      {/* Read-only echo of the toolbar's DB/schema picker so the
          user can see what context the next run will use without
          having to look up at the toolbar. */}
      {(activeDb || activeSchema) && (
        <span
          className="font-mono text-muted-foreground"
          title="Active database · schema (change in the toolbar picker)"
        >
          {activeDb ?? "—"}
          {activeSchema ? ` · ${activeSchema}` : ""}
        </span>
      )}

      <Sep />

      {/* Open-file path. Truncates from the left so the filename
          (the part the user looks for) is always visible at the
          right edge. The dirty `●` marker echoes the editor-tab
          strip so both indicators stay in sync. */}
      {path ? (
        <span
          className="flex min-w-0 items-center gap-1.5 font-mono"
          title={path}
        >
          <span className="truncate" dir="rtl">
            {path}
          </span>
          {dirty ? (
            <span
              className="inline-block size-1.5 shrink-0 rounded-full bg-foreground/80"
              title="Unsaved changes — ⌘S to save"
            />
          ) : null}
        </span>
      ) : (
        <span className="opacity-60">no file open</span>
      )}

      <span className="flex-1" />

      {/* Right edge — cache-progress mirror. Only renders when
          something's actually happening. */}
      <ProgressMirror />
    </div>
  );
}

function Sep() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border/60" />;
}

/**
 * Compact one-line mirror of `SchemaProgressIndicator`. We don't
 * re-implement the indicator's chip — we just summarise: "X jobs
 * running" or the single in-flight job's currentItem. The full
 * floating chips still render bottom-right via the indicator.
 */
function ProgressMirror() {
  const [jobs, setJobs] = useState<SchemaCacheProgressEvent[]>(() => readJobs());
  useEffect(() => {
    void awaitProgressSubscribed();
    return subscribeProgress(() => setJobs(readJobs()));
  }, []);

  // Keep only "actively running" jobs — terminal states are visible
  // for a beat in the floating indicator but the status bar should
  // be a steady "is anything happening *right now*" signal.
  const active = jobs.filter(
    (j) => j.state === "started" || j.state === "progress",
  );
  if (active.length === 0) return null;

  const head = active[0];
  const label =
    active.length > 1
      ? `${active.length} cache jobs`
      : head.currentItem
        ? head.currentItem
        : titleFor(head);
  const counter =
    active.length === 1 && head.total > 1
      ? `${Math.min(head.current, head.total)}/${head.total}`
      : null;

  return (
    <span className="flex items-center gap-1.5 truncate">
      <Loader2 className="size-3 shrink-0 animate-spin" />
      <span className="truncate font-mono" title={head.currentItem ?? ""}>
        {label}
      </span>
      {counter ? <span className="tabular-nums">{counter}</span> : null}
    </span>
  );
}

function titleFor(j: SchemaCacheProgressEvent): string {
  switch (j.kind) {
    case "catalog":
      return "Loading catalog";
    case "describe":
      return "Indexing schema";
    case "background":
      return "Refreshing cache";
  }
}
