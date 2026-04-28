import {
  Maximize2,
  Minimize2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type PaneState = "normal" | "collapsed" | "maximized";

interface PaneFrameProps {
  /** Title shown in the header. */
  title: string;
  /** Header right-side adornments (refresh button etc). */
  actions?: ReactNode;
  /** Body of the pane. Hidden when collapsed. */
  children: ReactNode;
  /** Current layout state. */
  state: PaneState;
  /** Toggle between collapsed ↔ normal. */
  onToggleCollapse: () => void;
  /** Toggle between maximized ↔ normal. */
  onToggleMaximize: () => void;
  /**
   * `true` if any *other* pane is currently maximized — in which case
   * this pane should not render its body (and probably won't be
   * mounted at all by the parent, but we no-op defensively).
   */
  hidden?: boolean;
  /** Pane orientation — affects which collapse glyph we show. */
  orientation?: "horizontal" | "vertical";
  /** Optional className on the outer wrapper. */
  className?: string;
}

/**
 * Shared chrome for every quadrant of the HTTP-runner layout. Renders a
 * sticky title bar with collapse + maximize buttons; the body slot is
 * scoped so child panes can fill remaining space with `flex-1`.
 */
export function PaneFrame({
  title,
  actions,
  children,
  state,
  onToggleCollapse,
  onToggleMaximize,
  hidden = false,
  orientation = "horizontal",
  className,
}: PaneFrameProps) {
  if (hidden) return null;

  const collapsed = state === "collapsed";
  const maximized = state === "maximized";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="truncate">{title}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {actions}
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand pane" : "Collapse pane"}
          >
            {orientation === "horizontal" ? (
              collapsed ? (
                <PanelLeftOpen className="size-3" />
              ) : (
                <PanelLeftClose className="size-3" />
              )
            ) : collapsed ? (
              <PanelBottomOpen className="size-3" />
            ) : (
              <PanelBottomClose className="size-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={onToggleMaximize}
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore pane" : "Maximize pane"}
          >
            {maximized ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </Button>
        </div>
      </div>
      {!collapsed && <div className="min-h-0 flex-1 overflow-hidden">{children}</div>}
    </div>
  );
}
