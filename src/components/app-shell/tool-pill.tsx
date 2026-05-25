import { AlertTriangle, BellDot, Check, Pause } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@zen-tools/ui";
import type { Tool } from "@/config/tools";
import { readLastPrmasterRoute } from "@/hooks/use-last-route";
import { BrailleSpinner } from "@/tools/terminal/components/braille-spinner";
import type { TerminalDisplayState } from "@/tools/terminal/lib/attention";

export interface ToolPillAttention {
  displayState: TerminalDisplayState;
  label: string;
  actionRequired: boolean;
  unhealthy: boolean;
}

interface ToolPillProps {
  tool: Tool;
  /** `true` when this pill represents the active tool. */
  active: boolean;
  /** Optional attention state rendered at the pill level. */
  attention?: ToolPillAttention | null;
}

/**
 * Single pill in the segmented tool selector. Uses a `Link` so the router
 * handles activation; the parent draws the shared background.
 */
export function ToolPill({ tool, active, attention }: ToolPillProps) {
  const Icon = tool.icon;
  const title = [tool.description, attention?.label].filter(Boolean).join(" — ");
  const to = tool.id === "prmaster" ? readLastPrmasterRoute() : tool.route;
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
        "transition-colors",
        active
          ? "bg-background text-foreground shadow-sm border"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {attention?.displayState === "loading" ? (
        <BrailleSpinner className="text-xs text-sky-500" />
      ) : attention?.displayState === "paused" ? (
        <Pause className="size-3 text-amber-500" />
      ) : attention?.displayState === "alert" ? (
        attention.actionRequired || attention.unhealthy ? (
          <AlertTriangle className="size-3 text-amber-500" />
        ) : (
          <BellDot className="size-3 text-orange-500" />
        )
      ) : attention?.displayState === "completed" ? (
        <Check className="size-3 text-emerald-500" strokeWidth={3} />
      ) : null}
      {tool.label}
    </Link>
  );
}
