/**
 * Left rail of the Merge tab — every conflicting path with its
 * conflict-status pill.
 */

import { CheckCircle2, FileWarning } from "lucide-react";
import { cn } from "@zen-tools/ui";

import type { ConflictFile } from "../../lib/tauri";

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

const STATUS_LABEL: Record<ConflictFile["status"], string> = {
  bothModified: "both modified",
  bothAdded: "both added",
  deletedByUs: "deleted by us",
  deletedByThem: "deleted by them",
  addedByUs: "added by us",
  addedByThem: "added by them",
  other: "manual",
};

export interface ConflictFileListProps {
  conflicts: ConflictFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  resolvedPaths: ReadonlySet<string>;
}

export function ConflictFileList({
  conflicts,
  activePath,
  onSelect,
  resolvedPaths,
}: ConflictFileListProps) {
  if (conflicts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground">
        <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" /> No conflicts.
      </div>
    );
  }
  return (
    <ul className="h-full overflow-auto py-1 text-xs">
      {conflicts.map((c) => {
        const resolved = resolvedPaths.has(c.path);
        return (
          <li key={c.path}>
            <button
              type="button"
              onClick={() => onSelect(c.path)}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent",
                activePath === c.path && "bg-accent",
              )}
              title={c.path}
            >
              {resolved ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px]">
                  {basename(c.path)}
                </div>
                {dirname(c.path) && (
                  <div className="truncate text-[10px] text-muted-foreground/80">
                    {dirname(c.path)}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">
                  {STATUS_LABEL[c.status]}
                  {c.binary && " · binary"}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
