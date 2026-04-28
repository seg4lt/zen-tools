import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import type { Tool } from "@/config/tools";

interface ToolPillProps {
  tool: Tool;
  /** `true` when this pill represents the active tool. */
  active: boolean;
}

/**
 * Single pill in the segmented tool selector. Uses a `Link` so the router
 * handles activation; the parent draws the shared background.
 */
export function ToolPill({ tool, active }: ToolPillProps) {
  const Icon = tool.icon;
  return (
    <Link
      to={tool.route}
      title={tool.description}
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
    </Link>
  );
}
