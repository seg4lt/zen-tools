/**
 * Left sidebar — list of scan folders + an Add button.
 *
 * Each entry shows:
 *   - the folder basename (full path on hover via `title`)
 *   - the scan status (idle/scanning/ready/error) as a small icon
 *   - the repo count once known
 *   - a remove button that appears on hover
 *
 * Add button opens the OS-native folder picker through Tauri.
 */

import {
  CheckCircle2,
  CircleAlert,
  Copy,
  FolderOpen,
  FolderPlus,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@zen-tools/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useCleanerStore } from "../store/cleaner-store";
import { useCleanerScans } from "../hooks/use-cleaner-scans";

export function FolderSidebar() {
  const { state } = useCleanerStore();
  const { addFolder, removeFolder, refreshFolder, refreshAll } = useCleanerScans();

  const onAdd = async () => {
    try {
      await addFolder();
    } catch (err) {
      console.error("[cleaner] add folder failed", err);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-64 shrink-0 flex-col overflow-hidden border-r bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Folders
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            title="Refresh all (R)"
            onClick={() => void refreshAll()}
          >
            <RefreshCw className="size-3" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            title="Add folder (a)"
            onClick={onAdd}
            className="gap-1"
          >
            <FolderPlus className="size-3" /> Add
          </Button>
        </div>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
        {state.folders.length === 0 ? (
          <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No folders yet. Click <span className="font-semibold">Add</span> to
            pick one.
          </li>
        ) : (
          state.folders.map((folder) => (
            <FolderItem
              key={folder}
              folder={folder}
              onRemove={() => void removeFolder(folder)}
              onRefresh={() => void refreshFolder(folder)}
            />
          ))
        )}
        <li className="mt-auto pt-2">
          <GlobalsItem onRefresh={() => void refreshFolder("globals")} />
        </li>
      </ul>
    </div>
  );
}

interface FolderItemProps {
  folder: string;
  onRemove: () => void;
  onRefresh: () => void;
}

function FolderItem({ folder, onRemove, onRefresh }: FolderItemProps) {
  const { state } = useCleanerStore();
  const status = state.scanStatus[folder] ?? "idle";
  const tree = state.trees[folder];
  const repoCount = tree
    ? tree.reduce(
        (acc, root) =>
          acc + (root.kind === "section" ? root.children.length : 1),
        0,
      )
    : null;
  const basename = pretty(folder);
  const progress = state.sizeProgress[folder];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="group flex min-w-0 flex-col gap-0.5 px-2 py-1 hover:bg-muted/40">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              title={folder}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <FolderOpen className="size-3.5 shrink-0 text-primary/70" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {basename}
              </span>
              <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/60">
                {status === "scanning" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : status === "error" ? (
                  <CircleAlert
                    className="size-3 text-destructive"
                    aria-label={state.scanError[folder]}
                  />
                ) : status === "ready" && repoCount != null && !progress ? (
                  <CheckCircle2 className="size-3 text-emerald-500/70" />
                ) : null}
                {repoCount != null && status !== "scanning" ? (
                  <span>
                    {repoCount} repo{repoCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              onClick={onRemove}
              title={`Remove ${basename}`}
              aria-label={`Remove ${basename}`}
              className={cn(
                "shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity",
                "hover:bg-destructive/15 hover:text-destructive",
                "group-hover:opacity-100 focus:opacity-100",
              )}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
          {progress ? <SizeProgressBar progress={progress} /> : null}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void writeText(folder)}>
          <Copy className="size-3.5" /> Copy path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRefresh()}>
          <RefreshCw className="size-3.5" /> Refresh
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onRemove()}
        >
          <Trash2 className="size-3.5" /> Remove folder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Tiny "estimating X/Y" indicator that mirrors the ratatui app's status
 * line.  Shows a thin progress bar plus a fractional counter, so the
 * user can see at a glance how much size estimation work remains.
 */
function SizeProgressBar({
  progress,
}: {
  progress: { completed: number; total: number };
}) {
  const pct =
    progress.total > 0
      ? Math.min(100, (progress.completed / progress.total) * 100)
      : 0;
  return (
    <div className="ml-5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/70 transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono tabular-nums">
        {progress.completed}/{progress.total}
      </span>
    </div>
  );
}

function GlobalsItem({ onRefresh }: { onRefresh: () => void }) {
  const { state } = useCleanerStore();
  const status = state.scanStatus["globals"] ?? "idle";
  const tree = state.trees["globals"];
  const targetCount = tree?.[0]?.children.length ?? null;
  const progress = state.sizeProgress["globals"];

  return (
    <div className="mx-2 mb-1 flex flex-col gap-1 rounded-md border border-dashed border-border/60 bg-muted/30 px-2 py-1.5">
      <button
        type="button"
        onClick={onRefresh}
        className="flex items-center gap-1.5 text-left"
        title="Global dev caches"
      >
        <FolderOpen className="size-3.5 shrink-0 text-fuchsia-500/70" />
        <span className="truncate text-xs font-medium">Global caches</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
          {status === "scanning" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          {targetCount != null ? <span>{targetCount}</span> : null}
        </span>
      </button>
      {progress ? <SizeProgressBar progress={progress} /> : null}
    </div>
  );
}

function pretty(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}
