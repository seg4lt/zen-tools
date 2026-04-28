import { Link, useRouterState } from "@tanstack/react-router";
import { ScrollText, Variable, Zap, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useHttpRunner } from "../store/http-runner-store";
import { EnvSelector } from "./env-selector";
import { VariableViewer } from "./variable-viewer";
import { LogsPanel } from "./logs-panel";

const SUBVIEWS = [
  {
    id: "requests",
    label: "Requests",
    route: "/http-runner/requests",
    icon: Zap,
  },
  {
    id: "performance",
    label: "Performance",
    route: "/http-runner/performance",
    icon: BarChart3,
  },
] as const;

/**
 * Sub-navigation bar that lives between the global title bar and the
 * tool's content. Hosts the Requests/Performance toggle plus tool-level
 * actions (env, variables, logs).
 */
export function HttpRunnerSubNav() {
  const { location } = useRouterState();
  const activeId = location.pathname.startsWith("/http-runner/performance")
    ? "performance"
    : "requests";
  const { state } = useHttpRunner();

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/50 px-3">
      {SUBVIEWS.map((sv) => {
        const Icon = sv.icon;
        const active = sv.id === activeId;
        return (
          <Link
            key={sv.id}
            to={sv.route}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {sv.label}
          </Link>
        );
      })}

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
            className="h-7 gap-1 px-2 text-xs"
            title="Logs (Cmd+L)"
          >
            <ScrollText className="size-3.5" />
            Logs
            {state.logs.length > 0 && (
              <Badge
                variant="secondary"
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
