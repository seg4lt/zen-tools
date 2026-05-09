/**
 * Compact one-row tab strip for the git tool.
 *
 * Renders the Log / Merge picker on the left and gives the caller two
 * named slots — `centerContent` and `rightActions` — to fill the rest
 * of the row. The whole row can be tinted (amber when the active
 * merge has unresolved files, emerald when ready-to-go) so the merge
 * state badge becomes a full-width affordance instead of a separate
 * second row.
 *
 * Used by `<CommitLogPane>` and `<MergePane>` so both share the same
 * tab affordance — the tabs live INSIDE the active-tab content (not
 * above it), which keeps the entire chrome to a single row instead
 * of stacking tab-strip + tab-specific-header.
 */

import type { ReactNode } from "react";
import { GitMerge, History } from "lucide-react";
import { cn } from "@zen-tools/ui";

import type { GitInitialTab } from "../../GitShell";

export interface TabStripProps {
  activeTab: GitInitialTab;
  onTabChange: (tab: GitInitialTab) => void;
  mergeBadge?: string | null;
  /** Visual tone applied to the row background. */
  tone?: "neutral" | "amber" | "emerald";
  centerContent?: ReactNode;
  rightActions?: ReactNode;
}

const TONE_CLASSES: Record<NonNullable<TabStripProps["tone"]>, string> = {
  neutral: "",
  amber: "bg-amber-500/10",
  emerald: "bg-emerald-500/10",
};

export function TabStrip({
  activeTab,
  onTabChange,
  mergeBadge,
  tone = "neutral",
  centerContent,
  rightActions,
}: TabStripProps) {
  return (
    <header
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-b px-2",
        TONE_CLASSES[tone],
      )}
    >
      <div className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background/40 p-0.5">
        <TabButton
          active={activeTab === "log"}
          onClick={() => onTabChange("log")}
          icon={<History className="h-3.5 w-3.5" />}
          label="Log"
        />
        <TabButton
          active={activeTab === "merge"}
          onClick={() => onTabChange("merge")}
          icon={<GitMerge className="h-3.5 w-3.5" />}
          label="Merge"
          badge={mergeBadge}
        />
      </div>

      {centerContent && (
        <div className="min-w-0 flex-1 text-xs">{centerContent}</div>
      )}
      {!centerContent && <div className="flex-1" />}

      {rightActions && (
        <div className="flex shrink-0 items-center gap-1">{rightActions}</div>
      )}
    </header>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: string | null;
}

function TabButton({ active, onClick, icon, label, badge }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors",
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      {badge && (
        <span
          className={cn(
            "ml-0.5 rounded px-1 font-mono text-[9px] leading-tight",
            "bg-amber-500/25 text-amber-700 dark:text-amber-300",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
