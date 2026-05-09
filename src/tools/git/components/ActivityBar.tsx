/**
 * VSCode-style activity bar — a thin (40 px) vertical strip of icons
 * pinned to the very left of the git tool. Each icon picks what the
 * adjacent side panel renders.
 *
 *   ┌──┬──────────┬─────────────────────┐
 *   │📁│ Repos    │                     │
 *   │📄│ ──────── │  Main content       │
 *   │  │ (panel)  │                     │
 *   └──┴──────────┴─────────────────────┘
 *
 * Clicking the *active* icon a second time collapses the side panel
 * (the same toggle gesture VSCode uses). Clicking a *different* icon
 * switches modes and re-opens the panel.
 */

import { FolderGit2, Files, Plus } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

export type SidePanelMode = "repos" | "files";

export interface ActivityBarItem {
  id: SidePanelMode;
  label: string;
  /** Lucide-style icon component. */
  icon: typeof FolderGit2;
  /** Optional badge text (e.g. unresolved conflict count). */
  badge?: string | null;
  /** Visual intent for the badge. */
  badgeTone?: "amber" | "emerald" | "muted";
}

export interface ActivityBarProps {
  /** Currently visible mode, or `null` if the panel is collapsed. */
  mode: SidePanelMode | null;
  onChangeMode: (mode: SidePanelMode | null) => void;
  items: ActivityBarItem[];
  /** Optional bottom-anchored button (e.g. "+" to add repo). */
  bottomActions?: React.ReactNode;
}

const TONE_CLASSES: Record<NonNullable<ActivityBarItem["badgeTone"]>, string> = {
  amber: "bg-amber-500/25 text-amber-700 dark:text-amber-300",
  emerald: "bg-emerald-500/25 text-emerald-700 dark:text-emerald-300",
  muted: "bg-muted text-muted-foreground",
};

export function ActivityBar({
  mode,
  onChangeMode,
  items,
  bottomActions,
}: ActivityBarProps) {
  return (
    <aside
      role="toolbar"
      aria-label="Sidebar mode"
      className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 py-1.5"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = mode === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChangeMode(active ? null : item.id)}
            title={`${item.label}${active ? " (click again to hide)" : ""}`}
            aria-pressed={active}
            className={cn(
              "relative flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors",
              "hover:text-foreground",
              active && "bg-accent text-foreground",
              // Left-side accent indicator on the active item.
              active &&
                "before:absolute before:left-[-6px] before:top-1.5 before:h-5 before:w-0.5 before:rounded-r before:bg-primary before:content-['']",
            )}
          >
            <Icon className="h-4 w-4" />
            {item.badge && (
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 min-w-[14px] rounded px-1 text-[9px] font-mono leading-[14px]",
                  TONE_CLASSES[item.badgeTone ?? "muted"],
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        {bottomActions}
      </div>
    </aside>
  );
}

/**
 * Convenience: a "+" button matching activity-bar styling, useful for
 * the "Add repo" affordance at the bottom of the rail.
 */
export function ActivityBarAddButton({
  onClick,
  disabled,
  title = "Add repository…",
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-7 w-7"
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}

export const ACTIVITY_BAR_ICONS = { FolderGit2, Files };
