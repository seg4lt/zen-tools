/**
 * Sidebar tree for the Files Changed view.
 *
 * Groups `FileDiff[]` into a directory tree, then collapses any chain
 * of single-child directories into a single label (the trick VS Code
 * uses to keep deep paths short — `src/tools/prmaster/components` →
 * one row instead of four). Each leaf carries a status icon, the
 * file basename, and `+N -M` counts.
 *
 * Selection lives in the parent (a single string path); we just emit
 * `onSelect`. Expand/collapse state lives locally.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileDiff as FileDiffIcon,
  FilePlus2,
  FileMinus2,
  FilePen,
  FolderClosed,
} from "lucide-react";
import { cn } from "@zen-tools/ui";
import type { FileDiff } from "../../lib/tauri";

interface Props {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** When provided, shows a comment-count badge per file. */
  commentsByPath?: Map<string, number>;
}

interface DirNode {
  kind: "dir";
  /** Display label — may be a `/`-joined chain after collapsing. */
  label: string;
  /** Stable id for expand state — concatenation of every label up to here. */
  id: string;
  depth: number;
  children: TreeNode[];
}

interface FileNode {
  kind: "file";
  label: string;
  depth: number;
  file: FileDiff;
}

type TreeNode = DirNode | FileNode;

export function PrFileTree({
  files,
  selectedPath,
  onSelect,
  commentsByPath,
}: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(() => collectAllDirIds(tree));

  const rows = useMemo(
    () => collectVisibleRows(tree, expanded),
    [tree, expanded],
  );

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      role="tree"
      aria-label="Changed files"
      className="flex h-full min-h-0 flex-col overflow-y-auto py-1 text-[12px]"
    >
      {rows.map((row) => {
        if (row.kind === "dir") {
          const isOpen = expanded.has(row.id);
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => toggle(row.id)}
              className={cn(
                "flex w-full items-center gap-1 px-1.5 py-0.5 text-left",
                "text-foreground/80 hover:bg-accent/40",
              )}
              style={{ paddingLeft: 6 + row.depth * 10 }}
            >
              {isOpen ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              <FolderClosed className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{row.label}</span>
            </button>
          );
        }
        const f = row.file;
        const selected = selectedPath === f.path;
        const commentCount = commentsByPath?.get(f.path) ?? 0;
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            className={cn(
              "flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left",
              "hover:bg-accent/40",
              selected && "bg-accent/60 text-foreground",
            )}
            style={{ paddingLeft: 6 + row.depth * 10 + 12 }}
            title={f.path}
          >
            <StatusIcon status={f.status} />
            <span className="truncate font-mono">{row.label}</span>
            <span className="ml-auto flex items-center gap-1 pl-2 font-mono text-[10px]">
              {commentCount > 0 && (
                <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">
                  {commentCount}
                </span>
              )}
              {f.additions > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{f.additions}
                </span>
              )}
              {f.deletions > 0 && (
                <span className="text-destructive">−{f.deletions}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StatusIcon({ status }: { status: FileDiff["status"] }) {
  const classes = "size-3 shrink-0";
  switch (status) {
    case "added":
      return <FilePlus2 className={cn(classes, "text-emerald-600 dark:text-emerald-400")} />;
    case "removed":
      return <FileMinus2 className={cn(classes, "text-destructive")} />;
    case "renamed":
      return <FilePen className={cn(classes, "text-amber-600 dark:text-amber-400")} />;
    default:
      return <FileDiffIcon className={cn(classes, "text-muted-foreground")} />;
  }
}

// ── Tree building ────────────────────────────────────────────────

interface MutableDir {
  label: string;
  /** Direct subdirectories keyed by name. */
  dirs: Map<string, MutableDir>;
  /** Direct file children keyed by basename. */
  files: FileDiff[];
}

function buildTree(files: FileDiff[]): TreeNode[] {
  const root: MutableDir = { label: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i] ?? "";
      let next = cur.dirs.get(segment);
      if (!next) {
        next = { label: segment, dirs: new Map(), files: [] };
        cur.dirs.set(segment, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return materialize(root, 0, "");
}

/** Walk the mutable tree, collapsing single-child dir chains. */
function materialize(dir: MutableDir, depth: number, idPrefix: string): TreeNode[] {
  const out: TreeNode[] = [];
  const dirEntries = [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, sub] of dirEntries) {
    let label = name;
    let cur = sub;
    // Collapse chains: while this dir has exactly one subdir and no
    // direct files, keep folding the subdir's name onto the label.
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [childName, childSub] = [...cur.dirs.entries()][0]!;
      label = `${label}/${childName}`;
      cur = childSub;
    }
    const id = `${idPrefix}/${label}`;
    out.push({
      kind: "dir",
      label,
      id,
      depth,
      children: materialize(cur, depth + 1, id),
    });
  }
  for (const f of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
    out.push({
      kind: "file",
      label: f.path.split("/").pop() ?? f.path,
      depth,
      file: f,
    });
  }
  return out;
}

/** Flatten the tree into the visible row list given the expanded set. */
function collectVisibleRows(
  nodes: TreeNode[],
  expanded: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.kind === "dir" && expanded.has(n.id)) {
      out.push(...collectVisibleRows(n.children, expanded));
    }
  }
  return out;
}

function collectAllDirIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.kind === "dir") {
        ids.add(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return ids;
}
