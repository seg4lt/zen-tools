/**
 * Left rail of the Merge tab — every conflicting path in a directory
 * tree, with a status icon and a tiny conflict-status pill.
 */

import { useMemo } from "react";
import { CheckCircle2, FileWarning } from "lucide-react";
import { cn } from "@zen-tools/ui";

import type { ConflictFile } from "../../lib/tauri";
import { FileTree, type FileTreeItem } from "../shared/FileTree";

interface LeafData {
  conflict: ConflictFile;
  resolved: boolean;
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
  const items = useMemo<FileTreeItem<LeafData>[]>(
    () =>
      conflicts.map((c) => ({
        path: c.path,
        data: { conflict: c, resolved: resolvedPaths.has(c.path) },
      })),
    [conflicts, resolvedPaths],
  );

  if (conflicts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground">
        <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" /> No conflicts.
      </div>
    );
  }
  return (
    <FileTree
      items={items}
      selectedPath={activePath}
      onSelect={onSelect}
      renderLeaf={({ conflict, resolved }, { basename }) => (
        <>
          {resolved ? (
            <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
          ) : (
            <FileWarning className="size-3 shrink-0 text-amber-500" />
          )}
          <span className="truncate font-mono">{basename}</span>
          <span
            className={cn(
              "ml-auto pl-2 text-[10px]",
              resolved
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
            title={STATUS_LABEL[conflict.status]}
          >
            {STATUS_LABEL[conflict.status]}
            {conflict.binary && " · bin"}
          </span>
        </>
      )}
    />
  );
}
