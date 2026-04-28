import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronRight, Folder, Settings } from "lucide-react";
import { tauri, type FileTreeItem } from "../lib/tauri";
import { cn } from "@/lib/utils";

interface PerfFileTreeProps {
  selectedPath: string | null;
  onSelect: (item: FileTreeItem) => void;
}

/** File tree filtered to perf YAML files. */
export function PerfFileTree({ selectedPath, onSelect }: PerfFileTreeProps) {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["perf-files"],
    queryFn: () => tauri.discoverPerfFiles(),
  });

  if (isLoading) {
    return <div className="p-3 text-xs text-muted-foreground">Scanning…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No perf YAML files found.
      </div>
    );
  }

  return (
    <ul role="tree" className="select-none py-1 text-sm">
      {items.map((item) => {
        const Icon =
          item.fileType === "perfFile"
            ? BarChart3
            : item.fileType === "perfVariableFile"
              ? Settings
              : Folder;
        const active = !item.isDir && item.path === selectedPath;
        const isPerf = item.fileType === "perfFile";
        return (
          <li key={item.path} role="treeitem" aria-selected={active}>
            <button
              type="button"
              onClick={() => onSelect(item)}
              disabled={item.isDir || !isPerf}
              style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pr-2 text-left",
                "hover:bg-muted/50",
                active && "bg-muted text-foreground",
                (item.isDir || !isPerf) &&
                  "cursor-default text-muted-foreground",
              )}
            >
              <ChevronRight className="size-3 shrink-0 opacity-30" />
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  item.fileType === "perfFile" && "text-fuchsia-500",
                  item.fileType === "perfVariableFile" && "text-yellow-500",
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
