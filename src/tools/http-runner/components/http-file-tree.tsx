import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  Settings,
} from "lucide-react";
import { tauri, type FileTreeItem, type FileType } from "../lib/tauri";
import { cn } from "@/lib/utils";

interface HttpFileTreeProps {
  selectedPath: string | null;
  onSelect: (item: FileTreeItem) => void;
}

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
      return Settings;
    default:
      return FileText;
  }
}

/**
 * Recursive list of `.http` / `.rest` / env / perf files under the active
 * working directory. Backed by React Query keyed on the working dir, so
 * `set_working_dir` invalidations cascade.
 */
export function HttpFileTree({ selectedPath, onSelect }: HttpFileTreeProps) {
  const {
    data: items = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["http-files"],
    queryFn: () => tauri.discoverHttpFiles(),
  });

  // The backend returns [] both when no working dir is set AND when the
  // directory has no .http files. We disambiguate with a quick getWorkingDir
  // probe — if no path is set, render the "pick a directory" CTA.
  const { data: workingDir } = useQuery({
    queryKey: ["working-dir"],
    queryFn: () => tauri.getWorkingDir(),
  });

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
  if (items.length === 0) {
    if (!workingDir) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <FolderSearch className="size-6 opacity-40" />
          <p>Click 📁 in the title bar to pick a working directory.</p>
        </div>
      );
    }
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No HTTP files in this directory.
      </div>
    );
  }

  return (
    <ul role="tree" className="select-none py-1 text-sm">
      {items.map((item) => {
        const Icon = iconFor(item.fileType, item.isDir);
        const active = !item.isDir && item.path === selectedPath;
        return (
          <li key={item.path} role="treeitem" aria-selected={active}>
            <button
              type="button"
              onClick={() => onSelect(item)}
              disabled={item.isDir}
              style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pr-2 text-left",
                "hover:bg-muted/50",
                active && "bg-muted text-foreground",
                item.isDir && "cursor-default text-muted-foreground",
              )}
            >
              {item.isDir ? (
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 opacity-30" />
              )}
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  item.fileType === "httpFile" && "text-primary",
                  item.fileType === "envFile" && "text-yellow-500",
                  item.fileType === "perfFile" && "text-fuchsia-500",
                )}
              />
              <span className="truncate font-mono text-xs">{item.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
