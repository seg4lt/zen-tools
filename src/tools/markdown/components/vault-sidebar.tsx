/**
 * Multi-vault file tree sidebar.
 *
 * One collapsible section per vault root.  Each leaf is a `.md` file
 * the user can click to open in the editor.  Top toolbar has an
 * "Add vault" button that opens the native folder picker.
 *
 * Adapted from `src/tools/http-runner/components/http-file-tree.tsx`
 * — same DFS-list-to-tree pattern (`buildTree`), same default-expand
 * + explicit-collapse semantics — but the queries call markdown
 * commands and rows are simpler (no file-type icons).
 */

import { useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isExpanded,
  useMarkdownStore,
} from "../store/markdown-store";
import { markdownTauri, type MarkdownFileItem, type MarkdownVaultDto } from "../lib/tauri";
import { useVaults } from "../hooks/use-vaults";

interface TreeNode {
  item: MarkdownFileItem;
  children: TreeNode[];
}

/** Walk the backend's DFS list and rebuild a nested tree. */
function buildTree(items: MarkdownFileItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { depth: number; children: TreeNode[] }[] = [
    { depth: -1, children: roots },
  ];
  for (const item of items) {
    while (stack.length > 0 && item.depth <= stack[stack.length - 1].depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] ?? { depth: -1, children: roots };
    const node: TreeNode = { item, children: [] };
    parent.children.push(node);
    if (item.isDir) {
      stack.push({ depth: item.depth, children: node.children });
    }
  }
  return roots;
}

export function VaultSidebar() {
  const { state } = useMarkdownStore();
  const { addVault, removeVault } = useVaults();

  const trees = useMemo(
    () =>
      state.vaults.map((root) => ({
        root,
        vault: state.files[root],
        tree: state.files[root] ? buildTree(state.files[root].items) : [],
      })),
    [state.vaults, state.files],
  );

  const onAddClick = async () => {
    try {
      await addVault();
    } catch (err) {
      console.error("[markdown] add vault failed", err);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-64 shrink-0 flex-col border-r bg-card/40">
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Vaults
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={onAddClick}
          title="Add vault folder"
          className="gap-1"
        >
          <FolderPlus className="size-3" /> Add
        </Button>
      </div>

      {state.bootstrapping ? (
        <div className="p-3 text-[11px] text-muted-foreground">
          <Loader2 className="mr-1 inline size-3 animate-spin" />
          Loading…
        </div>
      ) : state.vaults.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <FolderOpen className="size-6 opacity-40" />
          <p>
            No vaults yet. Click{" "}
            <span className="font-semibold">Add</span> above to pick a
            folder of `.md` files.
          </p>
        </div>
      ) : (
        <ul role="tree" className="flex-1 select-none overflow-y-auto py-1">
          {trees.map(({ root, vault, tree }) => (
            <VaultBlock
              key={root}
              root={root}
              vault={vault}
              tree={tree}
              onRemove={() => void removeVault(root)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface VaultBlockProps {
  root: string;
  vault: MarkdownVaultDto | undefined;
  tree: TreeNode[];
  onRemove: () => void;
}

function VaultBlock({ root, vault, tree, onRemove }: VaultBlockProps) {
  const { state, dispatch } = useMarkdownStore();
  const open = isExpanded(state.expanded, `vault:${root}`);
  const name = vault?.name ?? root.split("/").filter(Boolean).slice(-1)[0] ?? root;

  return (
    <li>
      <div
        className="group flex items-center gap-1 px-2 py-1 hover:bg-muted/50"
        title={root}
      >
        <button
          type="button"
          onClick={() =>
            dispatch({ type: "toggleExpand", nodeId: `vault:${root}` })
          }
          className="flex flex-1 items-center gap-1 truncate text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <FolderOpen className="size-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-semibold">{name}</span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          className={cn(
            "rounded-sm p-0.5 opacity-0 transition-opacity",
            "hover:bg-destructive/15 hover:text-destructive",
            "group-hover:opacity-100 focus:opacity-100",
          )}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {open && (
        <ul role="group" className="text-sm">
          {tree.length === 0 ? (
            <li className="py-1 pl-9 pr-2 text-[10px] italic text-muted-foreground">
              No markdown files yet.
            </li>
          ) : (
            tree.map((node) => <TreeRow key={node.item.path} node={node} />)
          )}
        </ul>
      )}
    </li>
  );
}

interface TreeRowProps {
  node: TreeNode;
}

function TreeRow({ node }: TreeRowProps) {
  const { state, dispatch } = useMarkdownStore();
  const { item, children } = node;
  const indent = item.depth * 12 + 18;
  const open = item.isDir ? isExpanded(state.expanded, item.path) : false;
  const active = !item.isDir && state.currentFile?.path === item.path;
  const isImage = item.kind === "image";

  const onClick = () => {
    if (item.isDir) {
      dispatch({ type: "toggleExpand", nodeId: item.path });
      return;
    }
    // Only markdown rows open in the editor.  Image rows are visual
    // — clicking does nothing today (intentional; double-click in
    // Finder works for now).
    if (item.kind === "markdown") {
      void openFile(item.path, dispatch);
    }
  };

  return (
    <li role="treeitem" aria-expanded={item.isDir ? open : undefined}>
      <button
        type="button"
        onClick={onClick}
        style={{ paddingLeft: `${indent}px` }}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-2 text-left",
          "hover:bg-muted/50",
          active && "bg-muted text-foreground",
          isImage && "cursor-default opacity-70",
        )}
        title={isImage ? item.path : undefined}
      >
        {item.isDir ? (
          open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {item.isDir ? (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        ) : isImage ? (
          <ImageIcon className="size-3.5 shrink-0 text-fuchsia-500/70" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-primary/70" />
        )}
        <span className="truncate font-mono text-xs">{item.name}</span>
      </button>
      {item.isDir && open && children.length > 0 && (
        <ul role="group">
          {children.map((child) => (
            <TreeRow key={child.item.path} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Open a file from disk and push it into the store + recents ring.
 *
 * Lives at module scope (rather than a hook) because the tree row's
 * onClick already has access to dispatch and we don't want to bloat
 * a component that's mounted hundreds of times.
 */
async function openFile(
  path: string,
  dispatch: ReturnType<typeof useMarkdownStore>["dispatch"],
) {
  try {
    const doc = await markdownTauri.readFile(path);
    dispatch({ type: "openFile", path, doc });
    // Fire-and-forget update of the recents ring.
    markdownTauri
      .pushRecent(path)
      .then((recents) => dispatch({ type: "setRecents", recents }))
      .catch(() => {});
  } catch (err) {
    console.error("[markdown] open file failed", path, err);
  }
}
