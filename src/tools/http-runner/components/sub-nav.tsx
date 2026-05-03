import { ScrollText, Variable } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { Badge } from "@zen-tools/ui";
import { useHttpRunner } from "../store/http-runner-store";
import { useVimMode } from "@/hooks/use-vim-mode";
import { EnvSelector } from "./env-selector";
import { VariableViewer } from "./variable-viewer";
import { LogsPanel } from "./logs-panel";

/**
 * Sub-navigation bar that lives between the global title bar and the
 * tool's content. Tool-level actions (env, variables, logs) live here.
 *
 * The previous two-tab Requests/Performance toggle has been merged
 * into a single view: opening a `.http` file shows the request list,
 * opening a `.perf.yaml` file shows the perf test list — both in the
 * same chrome.
 */
export function HttpRunnerSubNav() {
  const { state } = useHttpRunner();
  const { vimMode, setVimMode } = useVimMode();

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/50 px-3">
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void setVimMode(!vimMode)}
          className={cn(
            "h-7 gap-1 px-2 text-xs",
            vimMode
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={
            vimMode
              ? "Vim mode is ON — click to disable"
              : "Vim mode is OFF — click to enable"
          }
          aria-pressed={vimMode}
        >
          <span
            className={cn(
              "inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
              vimMode
                ? "border-primary bg-primary/15"
                : "border-border bg-muted",
            )}
            aria-hidden
          >
            <span
              className={cn(
                "size-3 rounded-full transition-transform",
                vimMode
                  ? "translate-x-3 bg-primary"
                  : "translate-x-0.5 bg-muted-foreground",
              )}
            />
          </span>
          <span className="font-mono">vim</span>
        </Button>
        <EnvSelector />
        <VariableViewer>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            title="Variables (Cmd+,)"
          >
            <Variable className="size-3.5" />
            Vars
          </Button>
        </VariableViewer>
        <LogsPanel>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 gap-1 px-2 text-xs",
              state.logs.some((l) => l.level === "error") &&
                "text-destructive",
            )}
            title="Logs (Cmd+L)"
          >
            <ScrollText className="size-3.5" />
            Logs
            {state.logs.length > 0 && (
              <Badge
                variant={
                  state.logs.some((l) => l.level === "error")
                    ? "destructive"
                    : "secondary"
                }
                className="ml-1 h-4 px-1 text-[10px]"
              >
                {state.logs.length}
              </Badge>
            )}
          </Button>
        </LogsPanel>
      </div>
    </div>
  );
}
