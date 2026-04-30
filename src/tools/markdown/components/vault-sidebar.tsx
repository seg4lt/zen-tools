/**
 * Multi-vault file tree sidebar with context menus + inline editing.
 *
 *   - Right-click a row to get a context menu.  File rows offer
 *     Rename + Delete (to trash); folders also offer New file / New
 *     folder; vault headers offer the same plus Refresh + Remove.
 *   - "Rename" swaps the row's label with an `<input>` pre-filled
 *     with the current name.  Enter commits, Esc / blur cancels (an
 *     empty value also cancels).
 *   - "New file" / "New folder" inserts a focused placeholder row
 *     inside the chosen parent.  Same Enter/Esc UX.
 *   - Delete uses the OS trash so a misclick is recoverable.
 *
 * Inline-edit state lives in the Markdown store (`editing`) so the
 * sidebar stays declarative — components just check the slice and
 * render an input where appropriate.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  activeTab,
  isExpanded,
  useMarkdownStore,
} from "../store/markdown-store";
import {
  markdownTauri,
  type MarkdownFileItem,
  type MarkdownVaultDto,
} from "../lib/tauri";
import { useVaults } from "../hooks/use-vaults";
import { useFileOps } from "../hooks/use-file-ops";

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
  const { addVault, removeVault, refresh } = useVaults();

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
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => void refresh()}
            title="Refresh file tree"
          >
            <RefreshCw className="size-3" />
          </Button>
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
  const { refresh } = useVaults();
  const open = isExpanded(state.expanded, `vault:${root}`);
  const name = vault?.name ?? root.split("/").filter(Boolean).slice(-1)[0] ?? root;

  // Render a placeholder row for the create-editing case when its
  // parentDir matches this vault's root.
  const showCreateRowAtRoot =
    state.editing?.kind === "create" && state.editing.parentDir === root;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "startCreate",
                parentDir: root,
                childKind: "file",
              })
            }
          >
            <FilePlus />
            <span>New file</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "startCreate",
                parentDir: root,
                childKind: "folder",
              })
            }
          >
            <FolderPlus />
            <span>New folder</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void refresh()}>
            <RefreshCw />
            <span>Refresh</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onRemove}>
            <FolderTree />
            <span>Remove vault</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <ul role="group" className="text-sm">
          {showCreateRowAtRoot ? (
            <CreatePlaceholder parentDir={root} indentDepth={0} />
          ) : null}
          {tree.length === 0 && !showCreateRowAtRoot ? (
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
  const active = !item.isDir && activeTab(state)?.path === item.path;
  const isImage = item.kind === "image";
  const isMarkdown = item.kind === "markdown";

  const isRenaming =
    state.editing?.kind === "rename" && state.editing.path === item.path;
  const showCreateChild =
    item.isDir &&
    state.editing?.kind === "create" &&
    state.editing.parentDir === item.path;

  const onClick = () => {
    if (isRenaming) return;
    if (item.isDir) {
      dispatch({ type: "toggleExpand", nodeId: item.path });
      return;
    }
    if (isMarkdown) {
      void openFile(item.path, dispatch);
    }
  };

  return (
    <li role="treeitem" aria-expanded={item.isDir ? open : undefined}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
            {isRenaming ? (
              <RenameInput
                seed={state.editing!.kind === "rename" ? state.editing!.seed : ""}
                path={item.path}
              />
            ) : (
              <span className="truncate font-mono text-xs">{item.name}</span>
            )}
          </button>
        </ContextMenuTrigger>
        <RowContextMenu node={node} />
      </ContextMenu>
      {item.isDir && open && (
        <ul role="group">
          {showCreateChild ? (
            <CreatePlaceholder
              parentDir={item.path}
              indentDepth={item.depth + 1}
            />
          ) : null}
          {children.map((child) => (
            <TreeRow key={child.item.path} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Per-row context menu.  Branches on `kind` so we don't show "New
 * file" on a leaf or "Open" on a directory.
 */
function RowContextMenu({ node }: { node: TreeNode }) {
  const { dispatch } = useMarkdownStore();
  const { deletePath } = useFileOps();
  const { item } = node;
  const isDir = item.isDir;

  const onRename = () =>
    dispatch({ type: "startRename", path: item.path, seed: item.name });
  const onDelete = () => void deletePath(item.path);

  return (
    <ContextMenuContent>
      {isDir ? (
        <>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "startCreate",
                parentDir: item.path,
                childKind: "file",
              })
            }
          >
            <FilePlus />
            <span>New file</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              dispatch({
                type: "startCreate",
                parentDir: item.path,
                childKind: "folder",
              })
            }
          >
            <FolderPlus />
            <span>New folder</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem onSelect={onRename}>
        <Pencil />
        <span>Rename…</span>
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 />
        <span>Move to trash</span>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * Inline rename input.  Mounts focused with the seed pre-selected so
 * the user can either type a fresh name or tweak the existing one.
 */
function RenameInput({ seed, path }: { seed: string; path: string }) {
  const { renamePath } = useFileOps();
  const { dispatch } = useMarkdownStore();
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(seed);
  const committedRef = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.focus();
    ref.current.select();
  }, []);

  const commit = async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || trimmed === seed) {
      dispatch({ type: "cancelEditing" });
      return;
    }
    await renamePath(path, trimmed);
    dispatch({ type: "cancelEditing" });
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    dispatch({ type: "cancelEditing" });
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => void commit()}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 truncate rounded-sm border border-primary/40 bg-background px-1 font-mono text-xs outline-none focus:border-primary"
    />
  );
}

/**
 * Placeholder row for "New file" / "New folder".  Renders an input
 * inline at the requested indent level.  Same Enter/Esc UX as
 * `RenameInput`; on commit invokes `createFile` / `createDir`.
 */
function CreatePlaceholder({
  parentDir,
  indentDepth,
}: {
  parentDir: string;
  indentDepth: number;
}) {
  const { state, dispatch } = useMarkdownStore();
  const { createFile, createDir } = useFileOps();
  const childKind =
    state.editing?.kind === "create" ? state.editing.childKind : "file";
  const indent = indentDepth * 12 + 18;
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const committedRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const commit = async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed) {
      dispatch({ type: "cancelEditing" });
      return;
    }
    let createdPath: string | null = null;
    if (childKind === "file") {
      createdPath = await createFile(parentDir, trimmed);
    } else {
      createdPath = await createDir(parentDir, trimmed);
    }
    dispatch({ type: "cancelEditing" });
    // Newly created markdown files: open them straight away.  Newly
    // created folders: leave the cursor wherever it was.
    if (createdPath && childKind === "file") {
      void openFile(createdPath, dispatch);
    }
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    dispatch({ type: "cancelEditing" });
  };

  return (
    <li
      style={{ paddingLeft: `${indent}px` }}
      className="flex items-center gap-1.5 py-1 pr-2"
    >
      <span className="size-3 shrink-0" />
      {childKind === "file" ? (
        <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={childKind === "file" ? "Untitled.md" : "New folder"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
        className="flex-1 truncate rounded-sm border border-primary/40 bg-background px-1 font-mono text-xs outline-none focus:border-primary"
      />
    </li>
  );
}

/**
 * Open a file from disk and push it into the store + recents ring.
 */
async function openFile(
  path: string,
  dispatch: ReturnType<typeof useMarkdownStore>["dispatch"],
) {
  try {
    const doc = await markdownTauri.readFile(path);
    dispatch({ type: "openFile", path, doc });
    markdownTauri
      .pushRecent(path)
      .then((recents) => dispatch({ type: "setRecents", recents }))
      .catch(() => {});
  } catch (err) {
    console.error("[markdown] open file failed", path, err);
  }
}
