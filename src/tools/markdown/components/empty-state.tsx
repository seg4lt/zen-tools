/**
 * "No file open" landing pane.  Shown in the editor area when the
 * user hasn't picked a `.md` yet but has at least one vault.  When
 * there isn't even a vault, the sidebar's own empty state covers it.
 */

import { FileText, FolderOpen } from "lucide-react";

export function EmptyState({
  hasVaults,
  onPickVault,
}: {
  hasVaults: boolean;
  onPickVault: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-10 text-center text-xs text-muted-foreground">
      {hasVaults ? (
        <>
          <FileText className="size-8 opacity-30" />
          <div className="text-base font-semibold text-foreground">
            Pick a note to start editing
          </div>
          <p className="max-w-sm">
            Click any file in the sidebar, or hit{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
              ⌘ O
            </kbd>{" "}
            to open the quick switcher.
          </p>
        </>
      ) : (
        <>
          <FolderOpen className="size-8 opacity-30" />
          <div className="text-base font-semibold text-foreground">
            No vault open
          </div>
          <p className="max-w-sm">
            Pick a folder of `.md` files to get started.
          </p>
          <button
            type="button"
            onClick={onPickVault}
            className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open a vault
          </button>
        </>
      )}
    </div>
  );
}
