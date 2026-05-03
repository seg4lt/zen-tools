import {
  Maximize2,
  Minimize2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
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
 * Shared chrome for every quadrant of the HTTP-runner layout.
 *
 * Has two distinct header layouts:
 * - **Normal / maximized**: full title + caller-provided actions +
 *   collapse + maximize buttons.
 * - **Collapsed (32-px strip)**: a single full-area expand button.
 *   The title and actions are hidden entirely — there isn't room for
 *   them and trying to squeeze them in just produces overlapping
 *   icons that the user can't click.
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

  // Collapsed strip — render only an expand button that fills the
  // entire 32-px header so there's a giant click target the user
  // can't miss.
  if (collapsed) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={`Expand ${title}`}
          title={`Expand ${title}`}
          className={cn(
            "flex h-8 w-full shrink-0 items-center justify-center border-b bg-card/40",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
            "transition-colors",
          )}
        >
          {orientation === "horizontal" ? (
            <PanelLeftOpen className="size-3.5" />
          ) : (
            <PanelBottomOpen className="size-3.5" />
          )}
        </button>
        {/* Vertical title in the body so the user can still tell
            which pane this strip belongs to. Click anywhere on the
            strip to expand. */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-hidden
          tabIndex={-1}
          className="flex flex-1 cursor-pointer items-start justify-center pt-3 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
          title={`Expand ${title}`}
        >
          <span
            className="truncate"
            style={{
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
            }}
          >
            {title}
          </span>
        </button>
      </div>
    );
  }

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
            title="Collapse"
            aria-label="Collapse pane"
          >
            {orientation === "horizontal" ? (
              <PanelLeftClose className="size-3" />
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
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
