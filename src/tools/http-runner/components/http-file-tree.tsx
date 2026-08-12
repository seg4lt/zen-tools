import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Settings,
  Trash2,
  Variable,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  tauri,
  type DiscoveredProject,
  type FileTreeItem,
  type FileType,
} from "../lib/tauri";
import { Button } from "@zen-tools/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useProjectActions } from "../hooks/use-projects";
import { onFileTreeChanged } from "@/lib/file-tree-events";

interface HttpFileTreeProps {
  selectedPath: string | null;
  onSelect: (item: FileTreeItem) => void;
}

/** Pick the icon for a leaf file (or use Folder for directories). */
function iconFor(type: FileType, isDir: boolean) {
  if (isDir) return Folder;
  switch (type) {
    case "httpFile":
      return FileText;
    case "envFile":
      return Settings;
    case "perfFile":
      return BarChart3;
    case "perfVariableFile":
      return Variable;
    default:
      return FileText;
  }
}

/** Internal hierarchical node — built from the depth-DFS list. */
interface TreeNode {
  item: FileTreeItem;
  children: TreeNode[];
}

/**
 * Walk the backend's pre-order DFS list and rebuild it as a nested tree
 * by tracking a stack of `(depth, children)` frames. O(N) per project.
 */
function buildTree(items: FileTreeItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  // Stack frames hold the children array we're currently appending to,
  // plus the depth that array's nodes sit at (i.e. their *own* depth).
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

/**
 * Persist `expandedPaths` to the on-disk preferences file. Reads the
 * existing file first so we don't clobber `workingDirs`. Cheap because
 * the file is small.
 */
async function persistExpanded(set: Set<string>): Promise<void> {
  try {
    const prefs = await tauri.getPreferences();
    prefs.expandedPaths = Array.from(set);
    await tauri.savePreferences(prefs);
  } catch (err) {
    console.warn("zen-tools: persisting expanded paths failed", err);
  }
}

/**
 * Recursive list of `.http` / `.rest` / env / perf files across every
 * open project root. Renders one collapsible section per project, with
 * a `+ Add project` button at the top and per-project remove on hover.
 */
export function HttpFileTree({ selectedPath, onSelect }: HttpFileTreeProps) {
  const queryClient = useQueryClient();
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["http-files"],
    queryFn: () => tauri.discoverHttpFiles(),
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onFileTreeChanged(({ scope }) => {
      if (scope === "http") {
        void queryClient.invalidateQueries({ queryKey: ["http-files"] });
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  const { addProject, removeProject } = useProjectActions();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [createParent, setCreateParent] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  // Hydrate the expanded set once from disk preferences. Skip persisting
  // until that first read completes, otherwise the synchronous initial
  // mount would write back an empty set and clobber the user's view.
  useEffect(() => {
    let cancelled = false;
    void tauri
      .getPreferences()
      .then((prefs) => {
        if (cancelled) return;
        setExpanded(new Set(prefs.expandedPaths));
        hydratedRef.current = true;
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the expanded-set whenever it changes (after the initial
  // hydration) so reopening the app keeps the user's preferred view.
  useEffect(() => {
    if (!hydratedRef.current) return;
    void persistExpanded(expanded);
  }, [expanded]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Default-expand a path if we've never seen it before — preserves the
  // current "all folders look open" UX for fresh installs while letting
  // the user collapse afterwards.
  const isExpanded = useCallback(
    (path: string) => {
      if (expanded.has(path)) return true;
      // If the user has explicitly collapsed it we'd have stored the
      // path in `expanded` with a sentinel — but a Set can't represent
      // both states. Use a second key prefix instead.
      return !expanded.has(`-:${path}`);
    },
    [expanded],
  );

  const setExplicit = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(path);
      next.delete(`-:${path}`);
      if (open) next.add(path);
      else next.add(`-:${path}`);
      return next;
    });
  }, []);

  const trees = useMemo<{ project: DiscoveredProject; tree: TreeNode[] }[]>(
    () => projects.map((p) => ({ project: p, tree: buildTree(p.items) })),
    [projects],
  );

  const onAddClick = async () => {
    try {
      await addProject();
    } catch (err) {
      console.error("add project failed", err);
    }
  };

  const startCreate = useCallback(
    (parentDir: string) => {
      setExplicit(parentDir, true);
      setCreateParent(parentDir);
    },
    [setExplicit],
  );

  const finishCreate = useCallback(
    async (path: string) => {
      setCreateParent(null);
      await queryClient.invalidateQueries({ queryKey: ["http-files"] });
      onSelect({
        name: path.split(/[\\/]/).pop() ?? path,
        path,
        isDir: false,
        depth: 0,
        expanded: false,
        fileType: "httpFile",
      });
    },
    [onSelect, queryClient],
  );

  if (isLoading) {
    return <div className="p-3 text-xs text-muted-foreground">Scanning…</div>;
  }
  if (isError) {
    return (
      <div className="p-3 text-xs text-destructive">
        {String((error as { message?: string })?.message ?? error)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar — always visible, even in the empty state, so the
          + button is discoverable. */}
      <div className="flex h-7 shrink-0 items-center justify-end border-b px-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[10px]"
          onClick={onAddClick}
          title="Add project folder"
        >
          <FolderPlus className="size-3" /> Add
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <FolderSearch className="size-6 opacity-40" />
          <p>
            No projects yet. Click <span className="font-semibold">Add</span>{" "}
            above to open a folder.
          </p>
        </div>
      ) : (
        <ul role="tree" className="flex-1 select-none overflow-y-auto py-1">
          {trees.map(({ project, tree }) => {
            const open = isExpanded(project.root);
            return (
              <li key={project.root} role="treeitem" aria-expanded={open}>
                <ProjectHeader
                  name={project.name}
                  root={project.root}
                  open={open}
                  onToggle={() => setExplicit(project.root, !open)}
                  onRemove={() => void removeProject(project.root)}
                  onStartCreate={() => startCreate(project.root)}
                />
                {open && (
                  <ul role="group" className="text-sm">
                    {tree.length === 0 && createParent !== project.root ? (
                      <li className="py-1 pl-9 pr-2 text-[10px] italic text-muted-foreground">
                        No HTTP files in this project.
                      </li>
                    ) : (
                      tree.map((node) => (
                        <TreeRow
                          key={node.item.path}
                          node={node}
                          selectedPath={selectedPath}
                          isExpanded={isExpanded}
                          onToggle={toggleExpanded}
                          onSelect={onSelect}
                          createParent={createParent}
                          onStartCreate={startCreate}
                          onCreate={finishCreate}
                          onCancelCreate={() => setCreateParent(null)}
                        />
                      ))
                    )}
                    {createParent === project.root && (
                      <CreateFilePlaceholder
                        parentDir={project.root}
                        depth={0}
                        onCreate={finishCreate}
                        onCancel={() => setCreateParent(null)}
                      />
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface ProjectHeaderProps {
  name: string;
  root: string;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onStartCreate: () => void;
}

function ProjectHeader({
  name,
  root,
  open,
  onToggle,
  onRemove,
  onStartCreate,
}: ProjectHeaderProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group flex items-center gap-1 px-2 py-1 hover:bg-muted/50"
          title={root}
        >
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-1 text-left"
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
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className={cn(
          "rounded-sm p-0.5 opacity-0 transition-opacity",
          "hover:bg-destructive/15 hover:text-destructive",
          "group-hover:opacity-100 focus:opacity-100",
        )}
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
      >
        <Trash2 className="size-3" />
      </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()} className="w-48">
        <ContextMenuItem onSelect={onStartCreate}>New HTTP file</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(root)}>
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={onRemove}
          className="text-destructive focus:text-destructive"
        >
          Remove project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TreeRowProps {
  node: TreeNode;
  selectedPath: string | null;
  isExpanded: (path: string) => boolean;
  onToggle: (path: string) => void;
  onSelect: (item: FileTreeItem) => void;
  createParent: string | null;
  onStartCreate: (parentDir: string) => void;
  onCreate: (path: string) => void;
  onCancelCreate: () => void;
}

function TreeRow({
  node,
  selectedPath,
  isExpanded,
  onToggle,
  onSelect,
  createParent,
  onStartCreate,
  onCreate,
  onCancelCreate,
}: TreeRowProps) {
  const { item, children } = node;
  // Indent: outermost project content sits flush at depth 0 plus a
  // baseline gutter for the chevron.
  const indent = item.depth * 12 + 18;
  const Icon = iconFor(item.fileType, item.isDir);
  const open = item.isDir ? isExpanded(item.path) : false;
  const active = !item.isDir && item.path === selectedPath;

  const onClick = () => {
    if (item.isDir) onToggle(item.path);
    else onSelect(item);
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
        )}
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
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            item.fileType === "httpFile" && "text-primary",
            item.fileType === "envFile" && "text-yellow-500",
            item.fileType === "perfFile" && "text-fuchsia-500",
            item.fileType === "perfVariableFile" && "text-orange-500",
          )}
        />
        <span className="truncate font-mono text-xs">{item.name}</span>
      </button>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()} className="w-48">
          {item.isDir && (
            <>
              <ContextMenuItem onSelect={() => onStartCreate(item.path)}>
                New HTTP file
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(item.path)}>
            Copy path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {item.isDir && open && children.length > 0 && (
        <ul role="group">
          {children.map((child) => (
            <TreeRow
              key={child.item.path}
              node={child}
              selectedPath={selectedPath}
              isExpanded={isExpanded}
              onToggle={onToggle}
              onSelect={onSelect}
              createParent={createParent}
              onStartCreate={onStartCreate}
              onCreate={onCreate}
              onCancelCreate={onCancelCreate}
            />
          ))}
        </ul>
      )}
      {item.isDir && open && createParent === item.path && (
        <CreateFilePlaceholder
          parentDir={item.path}
          depth={item.depth + 1}
          onCreate={onCreate}
          onCancel={onCancelCreate}
        />
      )}
    </li>
  );
}

function CreateFilePlaceholder({
  parentDir,
  depth,
  onCreate,
  onCancel,
}: {
  parentDir: string;
  depth: number;
  onCreate: (path: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    const timer = setTimeout(focus, 0);
    return () => clearTimeout(timer);
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
      onCreate(await tauri.createHttpFile(parentDir, trimmed));
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Create HTTP file failed: ${String((err as { message?: string })?.message ?? err)}`);
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
    <div
      className="flex items-center gap-1.5 py-1 pr-2"
      style={{ paddingLeft: `${depth * 12 + 33}px` }}
    >
      <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => void commit()}
        placeholder="Untitled.http"
        className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0 font-mono text-xs outline-none focus:border-foreground/30"
      />
    </div>
  );
}
