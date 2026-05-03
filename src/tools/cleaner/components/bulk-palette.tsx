/**
 * Bulk-action command palette (Cmd+K).
 *
 * Wraps `CommandDialog` with the global cleaner actions: bulk-mark
 * helpers, refresh shortcuts, and the discoverable "add folder" flow.
 * Replaces the IDE-style dropdown menu the user explicitly didn't want.
 */

import {
  ArrowDownAZ,
  CheckCircle2,
  FolderPlus,
  Keyboard,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@zen-tools/ui";
import {
  REPOS_SECTION_ID,
  useCleanerStore,
} from "../store/cleaner-store";
import { useCleanerScans } from "../hooks/use-cleaner-scans";

export function BulkPalette() {
  const { state, dispatch } = useCleanerStore();
  const { addFolder, refreshAll, refreshFolder, removeFolder } =
    useCleanerScans();

  const close = useCallback(
    () => dispatch({ type: "setPalette", open: false }),
    [dispatch],
  );

  const cursorFolder = (() => {
    if (!state.cursor) return null;
    if (state.cursor === REPOS_SECTION_ID) return null;
    // Repo leaf id: `repos/<abs-path>`
    const inner = state.cursor.startsWith("repos/")
      ? state.cursor.slice("repos/".length)
      : state.cursor;
    return (
      state.folders.find((f) => inner === f || inner.startsWith(`${f}/`)) ??
      null
    );
  })();

  return (
    <CommandDialog
      open={state.paletteOpen}
      onOpenChange={(open) => dispatch({ type: "setPalette", open })}
      title="Cleaner actions"
      description="Bulk-mark targets, refresh scans, or add a folder."
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>

        <CommandGroup heading="Mark">
          <CommandItem
            onSelect={() => {
              dispatch({ type: "bulkMark", kind: "repo", action: "clean" });
              close();
            }}
          >
            <Sparkles className="text-amber-500" />
            <span>Mark all repos · Clean</span>
            <CommandShortcut>git clean -fxd</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "bulkMark", kind: "repo", action: "delete" });
              close();
            }}
          >
            <Trash2 className="text-destructive" />
            <span>Mark all repos · Delete</span>
            <CommandShortcut>rm -rf</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({
                type: "bulkMark",
                kind: "globalPath",
                action: "delete",
              });
              close();
            }}
          >
            <Trash2 className="text-destructive" />
            <span>Mark all global caches · Delete</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "bulkMark", kind: "all", action: "delete" });
              close();
            }}
          >
            <Trash2 className="text-destructive" />
            <span>
              <strong>Bulk delete all</strong> — every repo + every cache
            </span>
            <CommandShortcut>danger</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "clearMarks" });
              close();
            }}
          >
            <XCircle />
            <span>Clear all marks</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Sort">
          <CommandItem
            onSelect={() => {
              dispatch({ type: "setSort", sort: "alpha" });
              close();
            }}
          >
            <ArrowDownAZ />
            <span>Sort: Alphabetical</span>
            {state.sort === "alpha" ? (
              <CommandShortcut>active</CommandShortcut>
            ) : null}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "setSort", sort: "clean" });
              close();
            }}
          >
            <Sparkles className="text-amber-500" />
            <span>Sort: By clean size (biggest first)</span>
            {state.sort === "clean" ? (
              <CommandShortcut>active</CommandShortcut>
            ) : null}
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "setSort", sort: "delete" });
              close();
            }}
          >
            <Trash2 className="text-destructive" />
            <span>Sort: By delete size (biggest first)</span>
            {state.sort === "delete" ? (
              <CommandShortcut>active</CommandShortcut>
            ) : null}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Scan">
          <CommandItem
            onSelect={() => {
              void refreshAll();
              close();
            }}
          >
            <RefreshCw />
            <span>Refresh all folders</span>
            <CommandShortcut>R</CommandShortcut>
          </CommandItem>
          {cursorFolder ? (
            <CommandItem
              onSelect={() => {
                void refreshFolder(cursorFolder);
                close();
              }}
            >
              <RefreshCw />
              <span>Refresh {pretty(cursorFolder)}</span>
              <CommandShortcut>r</CommandShortcut>
            </CommandItem>
          ) : null}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Folders">
          <CommandItem
            onSelect={() => {
              void addFolder();
              close();
            }}
          >
            <FolderPlus />
            <span>Add scan folder…</span>
            <CommandShortcut>a</CommandShortcut>
          </CommandItem>
          {state.folders.map((folder) => (
            <CommandItem
              key={folder}
              onSelect={() => {
                void removeFolder(folder);
                close();
              }}
            >
              <Trash2 className="text-destructive" />
              <span>Remove {pretty(folder)}</span>
              <CommandShortcut>{folder}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Run">
          <CommandItem
            onSelect={() => {
              dispatch({ type: "openConfirm" });
              close();
            }}
          >
            <CheckCircle2 className="text-emerald-500" />
            <span>Run marked actions…</span>
            <CommandShortcut>Enter</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              dispatch({ type: "setHelp", open: true });
              close();
            }}
          >
            <Keyboard />
            <span>Show keybindings</span>
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function pretty(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}
