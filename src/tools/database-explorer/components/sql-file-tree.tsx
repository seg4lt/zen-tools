/**
 * Left-rail SQL workspace: list of project folders + their `.sql`
 * files, with right-click context menus that mirror the markdown
 * tool's pattern (new file, new folder, rename, copy path, move to
 * trash).
 *
 * Inline-edit state lives in the store as `editing: EditingState`:
 *  - `kind: "rename"` → a row's label is replaced by `<RenameInput>`
 *  - `kind: "create"` → a `<CreatePlaceholder>` row is inserted as a
 *    direct child of the target folder so the user can type the new
 *    name in place
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  RefreshCw,
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
  useSqlProjectActions,
  useSqlProjects,
} from "../hooks/use-sql-workspace";
import { sqlWorkspaceTauri, type SqlFileTreeItem } from "../lib/tauri";
import { useDbExplorerStore } from "../store/db-explorer-store";
import { formatError } from "../lib/format-error";

interface SqlFileTreeProps {
  selectedPath: string | null;
  onSelect: (item: SqlFileTreeItem) => void;
  /** Optional — if provided, a chevron button collapses the rail. */
  onCollapse?: () => void;
}

interface TreeNode {
  item: SqlFileTreeItem;
  children: TreeNode[];
}

/** Rebuild the backend's pre-order DFS list as a nested tree. */
function buildTree(items: SqlFileTreeItem[]): TreeNode[] {
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

export function SqlFileTree({
  selectedPath,
  onSelect,
  onCollapse,
}: SqlFileTreeProps) {
  const { data: projects = [], isLoading } = useSqlProjects();
  const { addProject, removeProject, refresh } = useSqlProjectActions();
  const { state, dispatch } = useDbExplorerStore();

  // path → collapsed? Default-expanded for directories.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isExpanded = (path: string) => !collapsed.has(path);
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const expand = (path: string) =>
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          SQL Files
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            title="Add project folder"
            onClick={() => void addProject()}
          >
            <FolderPlus className="size-3" />
            Add
          </Button>
          {onCollapse && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              title="Collapse panel"
              onClick={onCollapse}
            >
              <PanelLeftClose className="size-3" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto py-1">
        {isLoading ? (
          <Empty label="Loading…" />
        ) : projects.length === 0 ? (
          <Empty label="No project folders. Click + Add to open one." />
        ) : (
          projects.map((project) => (
            <ProjectSection
              key={project.root}
              root={project.root}
              name={project.name}
              tree={buildTree(project.items)}
              selectedPath={selectedPath}
              editing={state.editing}
              expandedFor={isExpanded}
              toggle={toggle}
              expand={expand}
              onSelect={onSelect}
              onRemove={() => void removeProject(project.root)}
              onRefresh={() => void refresh()}
              onStartCreate={(parentDir, childKind) =>
                dispatch({ type: "start-create", parentDir, childKind })
              }
              onStartRename={(path, seed) =>
                dispatch({ type: "start-rename", path, seed })
              }
              onCancelEditing={() =>
                dispatch({ type: "cancel-editing" })
              }
              onAfterMutate={() => void refresh()}
              onPathDeleted={(path) => {
                // Path is gone from disk → buffer + tab need to go
                // with it. close-editor-tab handles the active-fallback
                // when the deleted file was the visible one.
                dispatch({ type: "close-editor-tab", path });
                dispatch({ type: "drop-buffer", path });
              }}
              onPathRenamed={(oldPath, newPath) => {
                if (state.bufferByPath[oldPath] !== undefined) {
                  dispatch({
                    type: "set-buffer",
                    path: newPath,
                    content: state.bufferByPath[oldPath]!,
                    dirty: !!state.dirtyByPath[oldPath],
                  });
                  dispatch({ type: "drop-buffer", path: oldPath });
                  // If the renamed file was open as an editor tab,
                  // swap it out so the strip reflects the new path.
                  // close-editor-tab handles the active-fallback;
                  // open-file restores the editor onto the new path.
                  if (state.openFilePaths.includes(oldPath)) {
                    dispatch({ type: "close-editor-tab", path: oldPath });
                    dispatch({ type: "open-file", path: newPath });
                  } else if (state.selectedFilePath === oldPath) {
                    dispatch({ type: "select-file", path: newPath });
                  }
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

interface SectionCallbacks {
  onSelect: (item: SqlFileTreeItem) => void;
  onStartCreate: (
    parentDir: string,
    childKind: "file" | "folder",
  ) => void;
  onStartRename: (path: string, seed: string) => void;
  onCancelEditing: () => void;
  onAfterMutate: () => void;
  onPathDeleted: (path: string) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
}

interface ProjectSectionProps extends SectionCallbacks {
  root: string;
  name: string;
  tree: TreeNode[];
  selectedPath: string | null;
  editing: import("../store/db-explorer-store").EditingState | null;
  expandedFor: (path: string) => boolean;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  onRemove: () => void;
  onRefresh: () => void;
}

function ProjectSection({
  root,
  name,
  tree,
  selectedPath,
  editing,
  expandedFor,
  toggle,
  expand,
  onRemove,
  onRefresh,
  ...callbacks
}: ProjectSectionProps) {
  const open = expandedFor(root);
  const showRootPlaceholder =
    editing?.kind === "create" && editing.parentDir === root;

  return (
    <div className="mb-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group flex items-center gap-1 px-1 py-0.5">
            <button
              type="button"
              onClick={() => toggle(root)}
              className="flex flex-1 items-center gap-1 truncate text-left text-xs font-medium"
              title={root}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              {open ? (
                <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{name}</span>
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="w-48"
        >
          <ContextMenuItem
            onSelect={() => {
              expand(root);
              callbacks.onStartCreate(root, "file");
            }}
          >
            New file
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              expand(root);
              callbacks.onStartCreate(root, "folder");
            }}
          >
            New folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void navigator.clipboard.writeText(root)}
          >
            Copy path
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRefresh}>Refresh</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={onRemove}
            className="text-destructive focus:text-destructive"
          >
            Remove project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {open && (
        <div>
          {tree.length === 0 && !showRootPlaceholder ? (
            <div className="px-6 py-1 text-[11px] italic text-muted-foreground">
              (no .sql files)
            </div>
          ) : (
            tree.map((node) => (
              <TreeRow
                key={node.item.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                editing={editing}
                expandedFor={expandedFor}
                toggle={toggle}
                expand={expand}
                {...callbacks}
              />
            ))
          )}
          {showRootPlaceholder && (
            <CreatePlaceholder
              parentDir={root}
              childKind={
                (editing as { childKind: "file" | "folder" }).childKind
              }
              depth={0}
              onCommit={callbacks.onAfterMutate}
              onCancel={callbacks.onCancelEditing}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface TreeRowProps extends SectionCallbacks {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  editing: import("../store/db-explorer-store").EditingState | null;
  expandedFor: (path: string) => boolean;
  toggle: (path: string) => void;
  expand: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  selectedPath,
  editing,
  expandedFor,
  toggle,
  expand,
  ...callbacks
}: TreeRowProps) {
  const { item } = node;
  const open = expandedFor(item.path);
  const isSelected = !item.isDir && selectedPath === item.path;
  const isRenaming =
    editing?.kind === "rename" && editing.path === item.path;
  const showChildPlaceholder =
    item.isDir &&
    editing?.kind === "create" &&
    editing.parentDir === item.path;

  const padLeft = 8 + (depth + 1) * 12;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {item.isDir ? (
            <button
              type="button"
              className="flex w-full items-center gap-1 truncate py-0.5 text-left text-xs hover:bg-muted/50"
              style={{ paddingLeft: padLeft }}
              onClick={() => toggle(item.path)}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )}
              {open ? (
                <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3 shrink-0 text-muted-foreground" />
              )}
              {isRenaming ? (
                <RenameInput
                  seed={(editing as { seed: string }).seed}
                  oldPath={item.path}
                  onCommit={(newPath) => {
                    callbacks.onPathRenamed(item.path, newPath);
                    callbacks.onCancelEditing();
                    callbacks.onAfterMutate();
                  }}
                  onCancel={callbacks.onCancelEditing}
                />
              ) : (
                <span className="truncate">{item.name}</span>
              )}
            </button>
          ) : (
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-1.5 truncate py-0.5 text-left text-xs",
                isSelected
                  ? "bg-muted text-foreground"
                  : "hover:bg-muted/50",
              )}
              style={{ paddingLeft: padLeft + 12 }}
              onClick={() => callbacks.onSelect(item)}
            >
              <FileText className="size-3 shrink-0 text-muted-foreground" />
              {isRenaming ? (
                <RenameInput
                  seed={(editing as { seed: string }).seed}
                  oldPath={item.path}
                  onCommit={(newPath) => {
                    callbacks.onPathRenamed(item.path, newPath);
                    callbacks.onCancelEditing();
                    callbacks.onAfterMutate();
                  }}
                  onCancel={callbacks.onCancelEditing}
                />
              ) : (
                <span className="truncate">{item.name}</span>
              )}
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="w-48"
        >
          {item.isDir && (
            <>
              <ContextMenuItem
                onSelect={() => {
                  expand(item.path);
                  callbacks.onStartCreate(item.path, "file");
                }}
              >
                New file
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  expand(item.path);
                  callbacks.onStartCreate(item.path, "folder");
                }}
              >
                New folder
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onSelect={() => callbacks.onStartRename(item.path, item.name)}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void navigator.clipboard.writeText(item.path)}
          >
            Copy path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={async () => {
              try {
                await sqlWorkspaceTauri.deleteToTrash(item.path);
                callbacks.onPathDeleted(item.path);
                callbacks.onAfterMutate();
              } catch (err) {
                // eslint-disable-next-line no-alert
                alert(`Move to trash failed: ${formatError(err)}`);
              }
            }}
            className="text-destructive focus:text-destructive"
          >
            Move to trash
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {item.isDir && open && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.item.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              editing={editing}
              expandedFor={expandedFor}
              toggle={toggle}
              expand={expand}
              {...callbacks}
            />
          ))}
          {showChildPlaceholder && (
            <CreatePlaceholder
              parentDir={item.path}
              childKind={
                (editing as { childKind: "file" | "folder" }).childKind
              }
              depth={depth + 1}
              onCommit={callbacks.onAfterMutate}
              onCancel={callbacks.onCancelEditing}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline-edit components ──────────────────────────────────────────────

function RenameInput({
  seed,
  oldPath,
  onCommit,
  onCancel,
}: {
  seed: string;
  oldPath: string;
  onCommit: (newPath: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);
  const [value, setValue] = useState(seed);

  useEffect(() => {
    const focus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Pre-select the basename without its extension when renaming a
      // file — the typical desired edit target.
      const dotIdx = seed.lastIndexOf(".");
      if (dotIdx > 0) el.setSelectionRange(0, dotIdx);
      else el.select();
    };
    focus();
    // Beat Radix's focus-restore on close.
    const t = setTimeout(focus, 0);
    return () => clearTimeout(t);
  }, [seed]);

  async function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed || trimmed === seed) {
      onCancel();
      return;
    }
    try {
      const newPath = await sqlWorkspaceTauri.rename(oldPath, trimmed);
      onCommit(newPath);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Rename failed: ${formatError(err)}`);
      onCancel();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => void commit()}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 rounded border border-border bg-background px-1 py-0 font-mono text-[11px] outline-none focus:border-foreground/30"
    />
  );
}

function CreatePlaceholder({
  parentDir,
  childKind,
  depth,
  onCommit,
  onCancel,
}: {
  parentDir: string;
  childKind: "file" | "folder";
  depth: number;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    const t = setTimeout(focus, 0);
    return () => clearTimeout(t);
  }, []);

  async function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    try {
      if (childKind === "file") {
        await sqlWorkspaceTauri.createFile(parentDir, trimmed);
      } else {
        await sqlWorkspaceTauri.createDir(parentDir, trimmed);
      }
      onCancel();
      onCommit();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Create ${childKind} failed: ${formatError(err)}`);
      onCancel();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  const padLeft = 8 + (depth + 1) * 12 + (childKind === "file" ? 12 : 0);

  return (
    <div
      className="flex items-center gap-1.5 py-0.5"
      style={{ paddingLeft: padLeft }}
    >
      {childKind === "file" ? (
        <FilePlus className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <FolderPlus className="size-3 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void commit()}
        placeholder={
          childKind === "file" ? "Untitled.sql" : "New folder"
        }
        className="flex-1 rounded border border-border bg-background px-1 py-0 font-mono text-[11px] outline-none focus:border-foreground/30"
      />
    </div>
  );
}
