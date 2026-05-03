/**
 * Main cleaner view: header / sidebar / tree / action bar.
 *
 * Layout uses straightforward flexbox — the sidebar has a fixed width
 * (the existing `DragHandle` resize machinery isn't worth the complexity
 * for this tool's two-pane shape; users mostly want the tree to fill).
 */

import {
  CheckCircle2,
  Command as CommandIcon,
  Keyboard,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { CleanerTree } from "./components/cleaner-tree";
import { FolderSidebar } from "./components/folder-sidebar";
import { BulkPalette } from "./components/bulk-palette";
import { RunConfirmDialog } from "./components/run-confirm-dialog";
import { ResultsSheet } from "./components/results-sheet";
import { HelpOverlay } from "./components/help-overlay";
import { useKeyboardNav } from "./hooks/use-keyboard-nav";
import { useCleanerScans } from "./hooks/use-cleaner-scans";
import { fmtSize } from "./lib/tauri";
import {
  markCounts,
  totalReclaimable,
  useCleanerStore,
} from "./store/cleaner-store";

export function CleanerView() {
  // Wire up bootstrap + keybindings exactly once.
  useCleanerScans();
  useKeyboardNav();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <FolderSidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <CleanerTree />
          <ActionBar />
        </div>
      </div>
      <BulkPalette />
      <RunConfirmDialog />
      <ResultsSheet />
      <HelpOverlay />
    </div>
  );
}

function Header() {
  const { state, dispatch } = useCleanerStore();
  const { refreshAll } = useCleanerScans();
  const counts = markCounts(state);
  const reclaim = totalReclaimable(state);

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
      <span className="text-sm font-medium">Cleaner</span>
      {counts.total > 0 ? (
        <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Sparkles className="size-3 text-amber-500" />
            {counts.clean}
          </span>
          <span className="inline-flex items-center gap-1">
            <Trash2 className="size-3 text-destructive" />
            {counts.delete}
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span>~{fmtSize(reclaim)}</span>
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          title="Refresh all (Shift+R)"
          onClick={() => void refreshAll()}
          className="gap-1"
        >
          <RefreshCw className="size-3" /> Refresh
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Bulk-action palette (⌘K)"
          onClick={() => dispatch({ type: "setPalette", open: true })}
          className="gap-1"
        >
          <CommandIcon className="size-3" /> Actions
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Keyboard shortcuts (?)"
          onClick={() => dispatch({ type: "setHelp", open: true })}
        >
          <Keyboard className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function ActionBar() {
  const { state, dispatch } = useCleanerStore();
  const counts = markCounts(state);
  const reclaim = totalReclaimable(state);
  const hasMarked = counts.total > 0;
  const isRunning = state.runState === "running";

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-3 border-t bg-card/40 px-3 text-xs",
        hasMarked && "bg-card/60",
      )}
    >
      <div className="inline-flex items-center gap-2 text-muted-foreground">
        {hasMarked ? (
          <>
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Sparkles className="size-3 text-amber-500" />
              {counts.clean}
            </span>
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Trash2 className="size-3 text-destructive" />
              {counts.delete}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono">~{fmtSize(reclaim)} reclaimable</span>
          </>
        ) : (
          <span className="text-muted-foreground/70">
            Press{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              Space
            </kbd>{" "}
            on a row to mark it.{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>{" "}
            for bulk actions.
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={!hasMarked || isRunning}
          onClick={() => dispatch({ type: "clearMarks" })}
        >
          Clear
        </Button>
        <Button
          size="sm"
          variant={counts.delete > 0 ? "destructive" : "default"}
          disabled={!hasMarked || isRunning}
          onClick={() => dispatch({ type: "openConfirm" })}
          className="gap-1"
        >
          <CheckCircle2 className="size-3.5" />
          Run {counts.total > 0 ? `(${counts.total})` : ""}
        </Button>
      </div>
    </div>
  );
}
