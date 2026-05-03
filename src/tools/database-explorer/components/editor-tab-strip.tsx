/**
 * VS-Code-style editor tab strip.
 *
 * Each open SQL file gets a tab here. The active tab uses the same
 * "lifted" treatment as the connection-tab strip: a 2-px primary
 * accent bar on top + `bg-background` surface + medium weight,
 * everything else fades to muted-foreground. A dirty buffer shows a
 * `●` before the close X; clicking the X removes the file from
 * `openFilePaths` and the reducer falls back to the neighbouring
 * tab as active so the editor never blanks unnecessarily.
 *
 * The component is multi-file ready by design even though most
 * sessions today open one file at a time — the only state it needs
 * lives in the store, so adding "open multiple files" later is a
 * matter of dispatching `open-file` from another callsite, not a
 * UI change.
 */
import { FileText, X } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useDbExplorerStore } from "../store/db-explorer-store";

export function EditorTabStrip() {
  const { state, dispatch } = useDbExplorerStore();
  const open = state.openFilePaths;

  if (open.length === 0) return null;

  return (
    // `bg-muted/60` matches the connection-tab strip vocabulary so
    // the eye groups the two horizontal rails as the same kind of
    // surface (deep-tinted "rail"); the active tab's `bg-background`
    // visibly lifts up out of it.
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/60 px-1.5 pt-1 text-[11px]">
      {open.map((path) => {
        const isActive = state.selectedFilePath === path;
        const isDirty = !!state.dirtyByPath[path];
        const name = basename(path);
        return (
          <div
            key={path}
            className={cn(
              "group relative flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1.5 transition",
              // Active = lifted background only. The previous
              // 2-px accent ring on top read as "selected with a
              // glowing border" and the user disliked it; a clean
              // surface lift is enough.
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground",
            )}
            title={path}
          >
            <button
              type="button"
              className="flex items-center gap-1.5"
              onClick={() => dispatch({ type: "select-file", path })}
            >
              <FileText className="size-3.5 shrink-0" />
              <span
                className={cn(
                  "font-mono",
                  isActive ? "font-medium" : "font-normal",
                )}
              >
                {name}
              </span>
              {isDirty ? (
                <span
                  className="ml-0.5 inline-block size-1.5 shrink-0 rounded-full bg-foreground/80"
                  title="Unsaved changes"
                />
              ) : null}
            </button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-4 w-4 p-0 transition",
                // The X is always visible on the active tab so the
                // user has an unambiguous "close this" affordance;
                // inactive tabs hide it on idle and reveal on hover
                // to keep the strip uncluttered.
                isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "close-editor-tab", path });
              }}
              title="Close (does not delete the file)"
            >
              <X className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Last path segment, with platform-agnostic separator handling. */
function basename(path: string): string {
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}
