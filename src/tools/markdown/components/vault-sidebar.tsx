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

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  PanelLeftClose,
  Pencil,
  PenLine,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  activeTab,
  isExpanded,
  useMarkdownStore,
} from "../store/markdown-store";
import {
  dirname,
  isHtmlPath,
  isMarkdownPath,
  isExcalidrawPath,
  markdownTauri,
  normalizePath,
  type MarkdownFileItem,
  type MarkdownVaultDto,
} from "../lib/tauri";
import { useOpenTerminalTab } from "../hooks/use-open-terminal-tab";
import { useVaults } from "../hooks/use-vaults";
import { useFileOps } from "../hooks/use-file-ops";

interface TreeNode {
  item: MarkdownFileItem;
  children: TreeNode[];
}

/**
 * MIME used by the file-tree drag operation.  The exact value isn't
 * inspected by anything outside this file — it just lets dragenter /
 * dragover decide whether to react (so dragging a *file from Finder*
 * over the tree doesn't trigger our move-into-folder UI).
 */
const TREE_DRAG_MIME = "application/x-zen-markdown-tree";

/**
 * Module-scope handle on the in-flight drag.  `dataTransfer.getData`
 * isn't readable during `dragover` for security reasons, so we mirror
 * the dragged absolute path here while a tree-row drag is in flight
 * and clear it on `dragend`.  Only one drag happens at a time.
 */
let draggedSourcePath: string | null = null;

/**
 * Predicate: would moving `source` into `targetDir` be a meaningful,
 * legal operation?  Used to gate the drop-target highlight so the
 * user only sees a glow on rows where letting go will actually do
 * something.
 *
 *   - Refuse drops onto the source itself.
 *   - Refuse drops into a descendant of the source (would corrupt
 *     the tree — same check the backend enforces).
 *   - Refuse drops into the source's existing parent (no-op move).
 */
function canDropInto(source: string, targetDir: string): boolean {
  if (!source) return false;
  if (source === targetDir) return false;
  // Drop into descendant — `targetDir` lives under `source/`.
  if (targetDir.startsWith(`${source}/`)) return false;
  // No-op — `source`'s parent already equals `targetDir`.
  const lastSlash = source.lastIndexOf("/");
  const parent = lastSlash > 0 ? source.slice(0, lastSlash) : "";
  if (parent === targetDir) return false;
  return true;
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

interface VaultSidebarProps {
  /** When provided, renders a collapse button in the header. */
  onCollapse?: () => void;
}

export function VaultSidebar({ onCollapse }: VaultSidebarProps = {}) {
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
    <div className="flex h-full min-h-0 min-w-0 w-full shrink-0 flex-col border-r bg-card/40">
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
          {onCollapse && (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onCollapse}
              title="Collapse panel"
            >
              <PanelLeftClose className="size-3" />
            </Button>
          )}
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
  const { movePath } = useFileOps();
  const { openTerminalTab } = useOpenTerminalTab();
  const open = isExpanded(state.expanded, `vault:${root}`);
  const name = vault?.name ?? root.split("/").filter(Boolean).slice(-1)[0] ?? root;

  // Render a placeholder row for the create-editing case when its
  // parentDir matches this vault's root.
  const showCreateRowAtRoot =
    state.editing?.kind === "create" && state.editing.parentDir === root;

  // Drag-over highlight for the vault header — drops land in the
  // vault root.  Counter avoids flicker as the cursor crosses child
  // elements (every dragenter/leave fires for descendants too).
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  // No `dataTransfer.types.includes(TREE_DRAG_MIME)` gate — WebKit
  // may not surface custom MIMEs in `types` during dragover.  The
  // module-scope `draggedSourcePath` is the source of truth and is
  // only set by our own dragstart handler, so a Finder file drag
  // (where it stays null) is naturally rejected by the next check.
  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!draggedSourcePath || !canDropInto(draggedSourcePath, root)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!draggedSourcePath || !canDropInto(draggedSourcePath, root)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const src = draggedSourcePath ?? e.dataTransfer.getData(TREE_DRAG_MIME);
    if (!src || !canDropInto(src, root)) return;
    void movePath(src, root);
  };

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              "group flex items-center gap-1 px-2 py-1 hover:bg-muted/50",
              dragOver && "bg-primary/15 outline outline-1 outline-primary/50",
            )}
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
        <ContextMenuContent
          // Radix restores focus to the trigger element by default
          // when the menu closes; that fires *after* our inline input
          // mounts and steals focus away.  Cancel the restore so the
          // input keeps focus.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
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
          <ContextMenuItem onSelect={() => void openTerminalTab(root)}>
            <FolderOpen />
            <span>Open Terminal Here</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copyToClipboard(root)}>
            <Copy />
            <span>Copy path</span>
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
  const { movePath } = useFileOps();
  const { item, children } = node;
  const indent = item.depth * 12 + 18;
  const open = item.isDir ? isExpanded(state.expanded, item.path) : false;
  const active = !item.isDir && activeTab(state)?.path === item.path;
  const isImage = item.kind === "image";
  const isExcalidraw = item.kind === "excalidraw";

  const isRenaming =
    state.editing?.kind === "rename" && state.editing.path === item.path;
  const showCreateChild =
    item.isDir &&
    state.editing?.kind === "create" &&
    state.editing.parentDir === item.path;

  // When this row becomes the active one (via search-palette open,
  // wikilink jump, etc.) scroll it into view so the user can see
  // where the open file lives in the tree.  `useLayoutEffect` so the
  // scroll happens before paint and avoids a visible jump.
  //
  // The row is a `<div role="button">` rather than a `<button>` —
  // WebKit (Tauri's WKWebView on macOS) does not reliably initiate
  // HTML5 drag-and-drop from a native `<button>`.  Switching to a
  // div with `role="button"` plus an Enter/Space keydown gives us
  // the same a11y story while restoring drag.
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (active) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const onClick = () => {
    if (isRenaming) return;
    if (item.isDir) {
      dispatch({ type: "toggleExpand", nodeId: item.path });
      return;
    }
    // Images stay visual-only (preview rendered elsewhere).  Every
    // other file — markdown, excalidraw, or a plain `kind: "file"`
    // (`.txt`, `.json`, a shell script, …) — opens in the editor.
    // The non-markdown ones land in CodeMirror with no special
    // mode; that's fine, the user just wants to read/edit text.
    if (!isImage) {
      void openFile(item.path, dispatch);
    }
  };

  // ─── Drag source ──────────────────────────────────────────────
  // Every row drags as itself.  We stash both a typed payload (so
  // a drop target *outside* this widget can read the path on drop)
  // and a module-scoped path mirror (so `dragover` handlers can
  // read it without waiting for the security-gated `getData` and
  // without depending on `dataTransfer.types` exposing custom MIMEs
  // — WebKit historically omits them).
  const onDragStart = (e: ReactDragEvent) => {
    e.stopPropagation();
    draggedSourcePath = item.path;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData(TREE_DRAG_MIME, item.path);
    } catch {
      // Some webviews refuse custom MIMEs; the module-scope mirror
      // is the source of truth anyway.
    }
    // text/plain fallback so dropping outside the app inserts a
    // sensible string rather than nothing.
    e.dataTransfer.setData("text/plain", item.path);
  };
  const onDragEnd = () => {
    draggedSourcePath = null;
  };

  // ─── Drop target (folders only) ───────────────────────────────
  // Counter pattern avoids flicker as the cursor crosses children.
  // We don't gate on `dataTransfer.types.includes(TREE_DRAG_MIME)`
  // because WebKit may not surface custom MIMEs in `types` during
  // dragover — `draggedSourcePath` non-null already tells us this
  // is one of *our* drags (Finder drops never set it).
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const targetDir = item.isDir ? item.path : null;

  const onDragEnter = (e: ReactDragEvent) => {
    if (!targetDir) return;
    if (!draggedSourcePath || !canDropInto(draggedSourcePath, targetDir)) {
      return;
    }
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: ReactDragEvent) => {
    if (!targetDir) return;
    if (!draggedSourcePath || !canDropInto(draggedSourcePath, targetDir)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDragLeave = () => {
    if (!targetDir) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: ReactDragEvent) => {
    if (!targetDir) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const src =
      draggedSourcePath ?? e.dataTransfer.getData(TREE_DRAG_MIME) ?? "";
    if (!src || !canDropInto(src, targetDir)) return;
    // Auto-expand the destination so the user sees the moved entry
    // appear in its new home.
    if (!open) dispatch({ type: "toggleExpand", nodeId: targetDir });
    void movePath(src, targetDir);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isRenaming) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <li role="treeitem" aria-expanded={item.isDir ? open : undefined}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={rowRef}
            role="button"
            tabIndex={isRenaming ? -1 : 0}
            onClick={onClick}
            onKeyDown={onKeyDown}
            draggable={!isRenaming}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{ paddingLeft: `${indent}px` }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-2 text-left",
              "hover:bg-muted/50",
              active && "bg-muted text-foreground",
              dragOver &&
                "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/50",
              // Plain images are display-only — dim them to signal
              // they aren't openable.  Excalidraw drawings ARE
              // openable, so they keep full opacity even though they
              // share the `.svg` extension.
              isImage && "cursor-default opacity-70",
            )}
            title={isImage || isExcalidraw ? item.path : undefined}
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
            ) : isExcalidraw ? (
              <PenLine className="size-3.5 shrink-0 text-violet-500/80" />
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
          </div>
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
  const { state, dispatch } = useMarkdownStore();
  const { deletePath } = useFileOps();
  const { openTerminalTab } = useOpenTerminalTab();
  const { item } = node;
  const isDir = item.isDir;

  const onRename = () =>
    dispatch({ type: "startRename", path: item.path, seed: item.name });
  const onDelete = () => void deletePath(item.path);

  // Compute vault-relative path lazily — only used when the user
  // picks the "Copy relative path" item.  Returns the absolute path
  // unchanged when no vault matches (defensive).
  const relativePath = (): string => {
    for (const vault of state.vaults) {
      if (item.path === vault) {
        return item.path.split("/").slice(-1)[0] ?? item.path;
      }
      const prefix = vault.endsWith("/") ? vault : `${vault}/`;
      if (item.path.startsWith(prefix)) return item.path.slice(prefix.length);
    }
    return item.path;
  };

  return (
    <ContextMenuContent
      // Same fix as the vault-block menu: stop Radix from restoring
      // focus to the trigger so our inline rename / new-file input
      // can keep it.
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
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
      <ContextMenuItem
        onSelect={() => void openTerminalTab(isDir ? item.path : dirname(item.path))}
      >
        <FolderOpen />
        <span>Open Terminal Here</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRename}>
        <Pencil />
        <span>Rename…</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copyToClipboard(item.path)}>
        <Copy />
        <span>Copy path</span>
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => void copyToClipboard(relativePath())}
      >
        <Copy />
        <span>Copy relative path</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
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
    // Schedule both an immediate attempt AND a deferred one — the
    // immediate call usually wins, and the `setTimeout(0)` covers
    // the case where Radix's portal teardown happens after our
    // mount and would otherwise steal focus back.
    ref.current?.focus();
    ref.current?.select();
    const id = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
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
    // Same belt-and-suspenders as `RenameInput`: focus immediately
    // *and* via a 0ms timeout so we win the race against Radix's
    // close-time focus restoration.
    ref.current?.focus();
    const id = window.setTimeout(() => ref.current?.focus(), 0);
    return () => window.clearTimeout(id);
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
 * Best-effort write to the system clipboard.  Used by the "Copy
 * path" / "Copy relative path" context-menu items.  Failures are
 * logged and swallowed — the operation is purely user-affordance.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[markdown] clipboard write failed", err);
  }
}

/**
 * Open a file from disk and push it into the store + recents ring.
 */
async function openFile(
  rawPath: string,
  dispatch: ReturnType<typeof useMarkdownStore>["dispatch"],
) {
  // Normalise so the same canonical form is dispatched regardless of
  // whether the caller hands us a tree-walker path or a manually-
  // constructed one — keeps tab dedup honest.
  const path = normalizePath(rawPath);
  // Drawings shouldn't load through `readFile` — the SVG can be
  // multi-MB and we don't want it sitting in `tab.doc` for the
  // reducer to churn over. Markdown docs keep the markdown editor;
  // other files use the plain text editor.
  const kind = isExcalidrawPath(path)
    ? "excalidraw"
    : isMarkdownPath(path)
      ? "markdown"
      : isHtmlPath(path)
        ? "html"
        : "file";
  try {
    if (kind === "excalidraw") {
      dispatch({ type: "openFile", path, doc: "", kind });
    } else {
      const doc = await markdownTauri.readFile(path);
      dispatch({ type: "openFile", path, doc, kind });
    }
    // Reveal in tree — keeps the sidebar in sync when the user
    // double-clicks a deeply-nested file or follows a wikilink.
    dispatch({ type: "revealPath", path });
    markdownTauri
      .pushRecent(path)
      .then((recents) => dispatch({ type: "setRecents", recents }))
      .catch(() => {});
  } catch (err) {
    console.error("[markdown] open file failed", rawPath, err);
  }
}
