import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HttpRequest } from "../lib/tauri";
import { stableId } from "../store/http-runner-store";

interface RequestListProps {
  filePath: string;
  requests: HttpRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun?: (request: HttpRequest) => void;
}

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-[var(--color-method-get)]/15 text-[var(--color-method-get)]",
  POST: "bg-[var(--color-method-post)]/15 text-[var(--color-method-post)]",
  PUT: "bg-[var(--color-method-put)]/15 text-[var(--color-method-put)]",
  DELETE: "bg-[var(--color-method-delete)]/15 text-[var(--color-method-delete)]",
  PATCH: "bg-[var(--color-method-patch)]/15 text-[var(--color-method-patch)]",
  HEAD: "bg-[var(--color-method-head)]/15 text-[var(--color-method-head)]",
  OPTIONS:
    "bg-[var(--color-method-options)]/15 text-[var(--color-method-options)]",
};

/**
 * Vertical list of requests for the open file. Each row shows a coloured
 * method badge, the request name, and (on hover) a run button.
 */
export function RequestList({
  filePath,
  requests,
  selectedId,
  onSelect,
  onRun,
}: RequestListProps) {
  if (requests.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        No requests parsed in this file.
      </div>
    );
  }

  return (
    <ul role="list" className="overflow-y-auto py-1 text-sm">
      {requests.map((req) => {
        const id = stableId(filePath, req);
        const active = id === selectedId;
        const display = req.name ?? `${req.method} ${req.url}`;
        return (
          <li key={id}>
            <div
              className={cn(
                "group flex items-center gap-2 px-2.5 py-1.5",
                "cursor-pointer hover:bg-muted/50",
                active && "bg-muted",
              )}
              onClick={() => onSelect(id)}
            >
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none",
                  METHOD_CLASS[req.method] ?? METHOD_CLASS.GET,
                )}
              >
                {req.method}
              </span>
              <span className="truncate text-xs">{display}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                {req.url.length > 24 ? `…${req.url.slice(-23)}` : req.url}
              </span>
              {onRun && (
                <button
                  type="button"
                  className={cn(
                    "ml-1 rounded-sm p-0.5 opacity-0 transition-opacity",
                    "hover:bg-primary/15 hover:text-primary",
                    "group-hover:opacity-100 focus:opacity-100",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun(req);
                  }}
                  aria-label={`Run ${display}`}
                  title={`Run ${display}`}
                >
                  <Play className="size-3" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
