import { AlertTriangle, BellDot, CheckCircle2, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@zen-tools/ui";
import type { Tool } from "@/config/tools";

export interface ToolPillAttention {
  loading: boolean;
  actionRequired: boolean;
  completed: boolean;
  unread: boolean;
  unhealthy: boolean;
  label: string;
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
  return (
    <Link
      to={tool.route}
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
      {tool.label}
      {attention?.loading ? (
        <Loader2 className="size-3 animate-spin text-sky-500" />
      ) : null}
      {attention?.actionRequired || attention?.unhealthy ? (
        <AlertTriangle className="size-3 text-amber-500" />
      ) : null}
      {attention?.completed && !attention?.loading && !attention?.actionRequired ? (
        <CheckCircle2 className="size-3 text-emerald-500" />
      ) : null}
      {!attention?.loading && attention?.unread ? (
        <BellDot className="size-3 text-foreground/80" />
      ) : null}
    </Link>
  );
}
