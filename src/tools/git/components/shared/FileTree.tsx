/**
 * Reusable file-path tree.
 *
 * Takes a flat `items: { path, data }[]`, groups by directory, then
 * collapses single-child dir chains (the VS Code trick — `src/tools/
 * prmaster/components` becomes one row instead of four). Selection
 * lives in the parent (`selectedPath` + `onSelect`); expand/collapse
 * lives locally and starts fully-expanded.
 *
 * The leaf row UI is owned by the caller via `renderLeaf` so each
 * consumer can show its own status badges, comment counts, etc.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderClosed } from "lucide-react";
import { cn } from "@zen-tools/ui";

export interface FileTreeItem<T> {
  path: string;
  data: T;
}

interface Props<T> {
  items: FileTreeItem<T>[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Render the leaf body — basename + caller-supplied chrome. */
  renderLeaf: (
    item: T,
    ctx: { basename: string; selected: boolean },
  ) => React.ReactNode;
  /** Optional extra class on the scroll container. */
  className?: string;
  /** Sort comparator for files within a directory. Defaults to path-asc. */
  sortFiles?: (a: T, b: T) => number;
}

interface DirNode<T> {
  kind: "dir";
  label: string;
  /** Stable id — concat of every label up to here. */
  id: string;
  depth: number;
  children: TreeNode<T>[];
}

interface FileNode<T> {
  kind: "file";
  label: string;
  depth: number;
  item: FileTreeItem<T>;
}

type TreeNode<T> = DirNode<T> | FileNode<T>;

export function FileTree<T>({
  items,
  selectedPath,
  onSelect,
  renderLeaf,
  className,
  sortFiles,
}: Props<T>) {
  const tree = useMemo(() => buildTree(items, sortFiles), [items, sortFiles]);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    collectAllDirIds(tree),
  );

  // If new directories appear (e.g. user picked a different commit),
  // make sure they're auto-expanded too.
  const visibleRows = useMemo(() => {
    const ids = collectAllDirIds(tree);
    let next = expanded;
    let changed = false;
    ids.forEach((id) => {
      if (!next.has(id)) {
        if (!changed) {
          next = new Set(next);
          changed = true;
        }
        next.add(id);
      }
    });
    return collectVisibleRows(tree, changed ? next : expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, expanded]);

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
      aria-label="Files"
      className={cn(
        "flex h-full min-h-0 flex-col overflow-y-auto py-1 text-[12px]",
        className,
      )}
    >
      {visibleRows.map((row) => {
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
              title={row.label}
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
        const it = row.item;
        const selected = selectedPath === it.path;
        return (
          <button
            key={it.path}
            type="button"
            onClick={() => onSelect(it.path)}
            className={cn(
              "flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left",
              "hover:bg-accent/40",
              selected && "bg-accent/60 text-foreground",
            )}
            style={{ paddingLeft: 6 + row.depth * 10 + 12 }}
            title={it.path}
          >
            {renderLeaf(it.data, { basename: row.label, selected })}
          </button>
        );
      })}
    </div>
  );
}

// ── Tree building ────────────────────────────────────────────────────

interface MutableDir<T> {
  label: string;
  dirs: Map<string, MutableDir<T>>;
  files: FileTreeItem<T>[];
}

function buildTree<T>(
  items: FileTreeItem<T>[],
  sortFiles?: (a: T, b: T) => number,
): TreeNode<T>[] {
  const root: MutableDir<T> = { label: "", dirs: new Map(), files: [] };
  for (const it of items) {
    const parts = it.path.split("/");
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
    cur.files.push(it);
  }
  return materialize(root, 0, "", sortFiles);
}

/** Walk the mutable tree, collapsing single-child dir chains. */
function materialize<T>(
  dir: MutableDir<T>,
  depth: number,
  idPrefix: string,
  sortFiles?: (a: T, b: T) => number,
): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const dirEntries = [...dir.dirs.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, sub] of dirEntries) {
    let label = name;
    let cur = sub;
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
      children: materialize(cur, depth + 1, id, sortFiles),
    });
  }
  const sortedFiles = [...dir.files].sort((a, b) => {
    if (sortFiles) {
      const cmp = sortFiles(a.data, b.data);
      if (cmp !== 0) return cmp;
    }
    return a.path.localeCompare(b.path);
  });
  for (const f of sortedFiles) {
    out.push({
      kind: "file",
      label: f.path.split("/").pop() ?? f.path,
      depth,
      item: f,
    });
  }
  return out;
}

function collectVisibleRows<T>(
  nodes: TreeNode<T>[],
  expanded: Set<string>,
): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.kind === "dir" && expanded.has(n.id)) {
      out.push(...collectVisibleRows(n.children, expanded));
    }
  }
  return out;
}

function collectAllDirIds<T>(nodes: TreeNode<T>[]): Set<string> {
  const ids = new Set<string>();
  const walk = (ns: TreeNode<T>[]) => {
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
