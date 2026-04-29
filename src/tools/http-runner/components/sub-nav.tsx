import { ScrollText, Variable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useHttpRunner } from "../store/http-runner-store";
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

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/50 px-3">
      <div className="ml-auto flex items-center gap-1.5">
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
