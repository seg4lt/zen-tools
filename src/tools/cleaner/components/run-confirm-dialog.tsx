/**
 * Bulk-run confirmation dialog.
 *
 * Lists every marked target, summarises the total reclaim estimate, and
 * gates execution behind a single "Run" button. Replaces the per-item
 * confirmation modal the ratatui app used.
 */

import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@zen-tools/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { fmtSize } from "../lib/tauri";
import {
  findNode,
  totalReclaimable,
  useCleanerStore,
} from "../store/cleaner-store";
import { useCleanerScans } from "../hooks/use-cleaner-scans";

export function RunConfirmDialog() {
  const { state, dispatch } = useCleanerStore();
  const { runMarked } = useCleanerScans();

  const items = useMemo(() => {
    const out: Array<{
      id: string;
      kind: "repo" | "globalPath";
      label: string;
      path: string;
      action: "clean" | "delete";
      bytes: number | null;
    }> = [];
    for (const [id, action] of Object.entries(state.actions)) {
      const node = findNode(state.trees, id);
      if (!node || node.kind === "section") continue;
      if (action === "none") continue;
      const bytes =
        node.kind === "repo"
          ? action === "clean"
            ? node.cleanSize
            : node.deleteSize
          : node.size;
      out.push({
        id,
        kind: node.kind as "repo" | "globalPath",
        label: node.label,
        path: node.path,
        action,
        bytes,
      });
    }
    return out;
  }, [state.actions, state.trees]);

  const total = totalReclaimable(state);
  const cleanCount = items.filter((i) => i.action === "clean").length;
  const deleteCount = items.filter((i) => i.action === "delete").length;
  const open = state.runState === "confirming" || state.runState === "running";
  const isRunning = state.runState === "running";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && state.runState === "confirming") {
          dispatch({ type: "cancelConfirm" });
        }
      }}
    >
      <DialogContent
        className="max-w-2xl"
        showCloseButton={!isRunning}
        onPointerDownOutside={(e) => isRunning && e.preventDefault()}
        onEscapeKeyDown={(e) => isRunning && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            Run {items.length} action{items.length === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            <span className="inline-flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1">
                <Sparkles className="size-3 text-amber-500" />
                {cleanCount} clean
              </span>
              <span className="inline-flex items-center gap-1">
                <Trash2 className="size-3 text-destructive" />
                {deleteCount} delete
              </span>
              <span className="ml-auto text-muted-foreground/80">
                Reclaim ~{fmtSize(total)}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-72 divide-y divide-border/40 overflow-y-auto rounded-md border bg-muted/30">
          {items.map((it) => (
            <li
              key={it.id}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-xs",
                it.action === "clean" && "bg-amber-500/5",
                it.action === "delete" && "bg-destructive/5",
              )}
            >
              {it.action === "clean" ? (
                <Sparkles className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <Trash2 className="size-3.5 shrink-0 text-destructive" />
              )}
              <span className="font-mono">{it.label}</span>
              <span
                className="truncate font-mono text-[10px] text-muted-foreground/60"
                title={it.path}
              >
                {it.path}
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {fmtSize(it.bytes)}
              </span>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => dispatch({ type: "cancelConfirm" })}
            disabled={isRunning}
          >
            Cancel
          </Button>
          <Button
            variant={deleteCount > 0 ? "destructive" : "default"}
            onClick={() => void runMarked()}
            disabled={isRunning || items.length === 0}
            className="gap-1.5"
          >
            {isRunning ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Running…
              </>
            ) : (
              <>
                {deleteCount > 0 ? (
                  <Trash2 className="size-3.5" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Run {items.length} action{items.length === 1 ? "" : "s"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
