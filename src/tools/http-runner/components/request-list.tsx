import { GitBranch, Play } from "lucide-react";
import { cn } from "@zen-tools/ui";
import type { HttpRequest } from "../lib/tauri";
import { stableId } from "../store/http-runner-store";
import { resolveUrl } from "../lib/resolve-url";

interface RequestListProps {
  filePath: string;
  requests: HttpRequest[];
  selectedId: string | null;
  /** Active env vars used to resolve `{{placeholders}}` in the URL preview. */
  envVars?: Record<string, string>;
  /** Extracted vars (from prior runs) used in the URL preview. */
  extractedVars?: Record<string, string>;
  /** File-local `@var = value` declarations. */
  localVars?: Record<string, string>;
  onSelect: (id: string) => void;
  /** Run a request without dependency resolution. */
  onRun?: (request: HttpRequest) => void;
  /** Run a request with full dependency resolution. */
  onRunWithDeps?: (request: HttpRequest) => void;
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
 * Vertical list of requests for the open file. Each row shows two
 * lines: the request name on top (with a coloured method badge) and
 * the resolved URL — `{{placeholders}}` substituted from the active
 * env + extracted vars — underneath. Hover reveals a Play and (when
 * the request has any `@depends` annotation) a GitBranch button.
 */
export function RequestList({
  filePath,
  requests,
  selectedId,
  envVars,
  extractedVars,
  localVars,
  onSelect,
  onRun,
  onRunWithDeps,
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
        const hasDeps = req.dependsOn && req.dependsOn.length > 0;
        const resolved = resolveUrl(req.url, envVars, extractedVars, localVars);
        const stillUnresolved = resolved.includes("{{");

        return (
          <li key={id}>
            <div
              className={cn(
                "group flex flex-col gap-0.5 px-2.5 py-1.5",
                "cursor-pointer hover:bg-muted/50",
                active && "bg-muted",
              )}
              onClick={() => onSelect(id)}
            >
              {/* Top line: badge + name + run buttons (right-aligned) */}
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none",
                    METHOD_CLASS[req.method] ?? METHOD_CLASS.GET,
                  )}
                >
                  {req.method}
                </span>
                <span className="truncate text-xs">{display}</span>
                {hasDeps && (
                  <GitBranch
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label="Has dependencies"
                  />
                )}
                <div className="ml-auto flex items-center gap-0.5">
                  {onRunWithDeps && hasDeps && (
                    <button
                      type="button"
                      className={cn(
                        "rounded-sm p-0.5 opacity-0 transition-opacity",
                        "hover:bg-primary/15 hover:text-primary",
                        "group-hover:opacity-100 focus:opacity-100",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRunWithDeps(req);
                      }}
                      aria-label={`Run ${display} with dependencies`}
                      title={`Run with dependencies (${req.dependsOn.length})`}
                    >
                      <GitBranch className="size-3" />
                    </button>
                  )}
                  {onRun && (
                    <button
                      type="button"
                      className={cn(
                        "rounded-sm p-0.5 opacity-0 transition-opacity",
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
              </div>
              {/* Bottom line: resolved URL */}
              <div
                className={cn(
                  "truncate pl-9 font-mono text-[10px]",
                  stillUnresolved
                    ? "text-amber-500"
                    : "text-muted-foreground",
                )}
                title={resolved}
              >
                {resolved}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
