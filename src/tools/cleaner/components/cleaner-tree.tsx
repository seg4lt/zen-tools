/**
 * Main pane: a flat scrollable list of `TreeRow`s.
 *
 * Reads the *aggregated* roots from the store — a single virtual
 * `Repositories` section that merges every scan-folder's repos, plus
 * the `Globals` section.  Renderings is driven by the store's
 * derived `aggregatedRoots` and `flat` lists, so cursor navigation
 * (`j`/`k`) lines up exactly with what the user sees.
 *
 * The Repositories section header carries an inline sort toggle
 * (alpha / clean ↓ / delete ↓) and a small "scanning" indicator that
 * lights up while *any* configured folder is still walking.
 */

import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  GLOBALS_KEY,
  REPOS_SECTION_ID,
  useCleanerStore,
  type CleanerState,
  type SortMode,
} from "../store/cleaner-store";
import { TreeRow } from "./tree-row";
import type { CleanerTreeNode } from "../lib/tauri";
import { cn } from "@/lib/utils";

export function CleanerTree() {
  const { state, dispatch } = useCleanerStore();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the cursor row visible when keyboard nav scrolls past the edge.
  useEffect(() => {
    if (!state.cursor) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-row-id="${cssEscape(state.cursor)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [state.cursor]);

  const visibleRows = useMemo(
    () => collectVisibleRows(state.aggregatedRoots, state.expanded),
    [state.aggregatedRoots, state.expanded],
  );

  const anyFolderScanning = useMemo(
    () =>
      state.folders.some((f) => state.scanStatus[f] === "scanning") ||
      Object.entries(state.scanStatus).some(
        ([k, v]) => v === "scanning" && k !== GLOBALS_KEY && !state.folders.includes(k),
      ),
    [state.folders, state.scanStatus],
  );
  const globalsScanning = state.scanStatus[GLOBALS_KEY] === "scanning";

  if (state.aggregatedRoots.length === 0) {
    return <EmptyState />;
  }

  const isRunning = state.runState === "running";

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Cleanup targets"
      className="relative flex h-full min-h-0 flex-col overflow-y-auto"
    >
      {visibleRows.map((row) => {
        // Custom render for the merged Repositories section so we can
        // tuck the sort toggle into its header bar.
        if (row.kind === "section" && row.id === REPOS_SECTION_ID) {
          return (
            <ReposSectionHeader
              key={row.id}
              row={row}
              expanded={isExpandedDefaultOn(state.expanded, row.id)}
              active={state.cursor === row.id}
              scanning={anyFolderScanning}
              sort={state.sort}
              onToggle={() =>
                dispatch({ type: "toggleExpand", nodeId: row.id })
              }
              onSelect={() => dispatch({ type: "setCursor", nodeId: row.id })}
              onSortChange={(sort) => dispatch({ type: "setSort", sort })}
            />
          );
        }
        if (row.kind === "section" && row.id === "globals") {
          // Globals section header still uses the default chrome but
          // mirrors the scanning indicator from the sidebar.
          return (
            <GlobalsSectionHeader
              key={row.id}
              row={row}
              expanded={isExpandedDefaultOn(state.expanded, row.id)}
              active={state.cursor === row.id}
              scanning={globalsScanning}
              onToggle={() =>
                dispatch({ type: "toggleExpand", nodeId: row.id })
              }
              onSelect={() => dispatch({ type: "setCursor", nodeId: row.id })}
            />
          );
        }
        return (
          <RowContainer
            key={row.id}
            row={row}
            cursor={state.cursor}
            actions={state.actions}
            expanded={(id) => isExpandedDefaultOn(state.expanded, id)}
            disabled={isRunning}
            dispatch={dispatch}
          />
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

function collectVisibleRows(
  roots: CleanerTreeNode[],
  expanded: Set<string>,
): CleanerTreeNode[] {
  const out: CleanerTreeNode[] = [];
  for (const root of roots) walkVisible(root, expanded, out);
  return out;
}

function walkVisible(
  node: CleanerTreeNode,
  expanded: Set<string>,
  out: CleanerTreeNode[],
): void {
  out.push(node);
  if (node.isDir && isExpandedDefaultOn(expanded, node.id)) {
    for (const child of node.children) walkVisible(child, expanded, out);
  }
}

function isExpandedDefaultOn(expanded: Set<string>, id: string): boolean {
  if (expanded.has(id)) return true;
  return !expanded.has(`-:${id}`);
}

function cssEscape(s: string): string {
  if (typeof window !== "undefined" && window.CSS?.escape) {
    return window.CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// Per-row container for non-section rows — wraps `TreeRow` with cursor
// + action plumbing drawn from the store.
interface RowContainerProps {
  row: CleanerTreeNode;
  cursor: string | null;
  actions: CleanerState["actions"];
  expanded: (id: string) => boolean;
  disabled: boolean;
  dispatch: ReturnType<typeof useCleanerStore>["dispatch"];
}

function RowContainer({
  row,
  cursor,
  actions,
  expanded,
  disabled,
  dispatch,
}: RowContainerProps) {
  const action = actions[row.id] ?? "none";
  const active = cursor === row.id;
  return (
    <div data-row-id={row.id}>
      <TreeRow
        node={row}
        expanded={expanded(row.id)}
        action={action}
        active={active}
        disabled={disabled}
        onSelect={() => dispatch({ type: "setCursor", nodeId: row.id })}
        onToggleExpand={() =>
          dispatch({ type: "toggleExpand", nodeId: row.id })
        }
        onCycleAction={() =>
          dispatch({ type: "cycleAction", nodeId: row.id })
        }
      />
    </div>
  );
}

// ── Section headers ────────────────────────────────────────────────────

interface ReposSectionHeaderProps {
  row: CleanerTreeNode;
  expanded: boolean;
  active: boolean;
  scanning: boolean;
  sort: SortMode;
  onToggle: () => void;
  onSelect: () => void;
  onSortChange: (sort: SortMode) => void;
}

function ReposSectionHeader({
  row,
  expanded,
  active,
  scanning,
  sort,
  onToggle,
  onSelect,
  onSortChange,
}: ReposSectionHeaderProps) {
  const count = row.children.length;
  return (
    <div
      data-row-id={row.id}
      onClick={onSelect}
      className={cn(
        "group flex h-7 cursor-default items-center gap-2 border-b border-border/40 bg-muted/30 px-2",
        active && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex items-center gap-1.5"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {row.label}
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
          {count} item{count === 1 ? "" : "s"}
        </span>
      </button>
      {scanning ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <Loader2 className="size-3 animate-spin" />
          scanning…
        </span>
      ) : null}
      <SortToggle current={sort} onChange={onSortChange} />
    </div>
  );
}

interface GlobalsSectionHeaderProps {
  row: CleanerTreeNode;
  expanded: boolean;
  active: boolean;
  scanning: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

function GlobalsSectionHeader({
  row,
  expanded,
  active,
  scanning,
  onToggle,
  onSelect,
}: GlobalsSectionHeaderProps) {
  const count = row.children.length;
  return (
    <div
      data-row-id={row.id}
      onClick={onSelect}
      className={cn(
        "group flex h-7 cursor-default items-center gap-2 border-b border-border/40 bg-muted/30 px-2",
        active && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex items-center gap-1.5"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {row.label}
        </span>
        <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
          {count} item{count === 1 ? "" : "s"}
        </span>
      </button>
      {scanning ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <Loader2 className="size-3 animate-spin" />
          scanning…
        </span>
      ) : null}
    </div>
  );
}

// ── Sort toggle ────────────────────────────────────────────────────────

interface SortToggleProps {
  current: SortMode;
  onChange: (sort: SortMode) => void;
}

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "alpha", label: "A→Z" },
  { value: "clean", label: "clean ↓" },
  { value: "delete", label: "delete ↓" },
];

/**
 * Inline three-state segmented control for the sort mode.  Lives on the
 * Repositories section header.  Clicks (and the `s` shortcut) cycle
 * between the three modes; each pill has a distinct hover affordance so
 * the user can also pick directly.
 */
function SortToggle({ current, onChange }: SortToggleProps) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/40 p-0.5 text-[10px]"
      title="Sort repos · press s to cycle"
    >
      <span className="px-1 text-muted-foreground/60">sort</span>
      {SORT_OPTIONS.map((opt) => {
        const active = opt.value === current;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(opt.value);
            }}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono uppercase tracking-wider transition-colors",
              active
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-10 text-center text-xs text-muted-foreground">
      <div className="text-base font-semibold text-foreground">
        Nothing to scan yet
      </div>
      <p className="max-w-sm">
        Add a folder to discover its git repositories, or press{" "}
        <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
          a
        </kbd>{" "}
        to open the picker. Global dev caches will appear as soon as the
        background scan finishes.
      </p>
    </div>
  );
}
