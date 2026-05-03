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

export interface EditorTabStripProps {
  /** Open file paths (shared across all splits). */
  paths: string[];
  /** Path active in *this* strip. May differ across splits. */
  activePath: string | null;
  /** Per-path dirty flag. */
  dirtyByPath: Record<string, boolean>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export function EditorTabStrip({
  paths,
  activePath,
  dirtyByPath,
  onSelect,
  onClose,
}: EditorTabStripProps) {
  if (paths.length === 0) return null;

  return (
    // `bg-muted/60` matches the connection-tab strip vocabulary so
    // the eye groups the two horizontal rails as the same kind of
    // surface (deep-tinted "rail"); the active tab's `bg-background`
    // visibly lifts up out of it.
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/60 px-1.5 pt-1 text-[11px]">
      {paths.map((path) => {
        const isActive = activePath === path;
        const isDirty = !!dirtyByPath[path];
        const name = basename(path);
        return (
          <div
            key={path}
            className={cn(
              "group relative flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-1.5 transition",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground",
            )}
            title={path}
          >
            <button
              type="button"
              className="flex items-center gap-1.5"
              onClick={() => onSelect(path)}
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
                isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
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
