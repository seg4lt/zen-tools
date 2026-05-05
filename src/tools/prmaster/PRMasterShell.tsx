/**
 * PRMaster — top-level shell.
 *
 * Tab inventories:
 *
 *   - **Compact** (menu-bar popover): Review · Done · Mine.
 *   - **Full** (main window): adds Filters · AI · API · Settings.
 *
 * Window detection happens via `getCurrentWindow().label`; the popover
 * also dismisses on blur (mirrors macOS `NSPopover` behaviour).
 *
 * Keyboard nav: `1` / `2` / `3` jump to the first three tabs;
 * `←` / `→` cycle through every visible tab.
 *
 * Tab pills carry numeric badge counts derived from the store; only
 * the three list tabs (Review / Done / Mine) report counts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Bell,
  CheckCircle2,
  GitPullRequest,
  Inbox,
  Loader2,
  Settings as SettingsIcon,
  Sparkles,
  User,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { AiSummaryTab } from "./components/tabs/AiSummaryTab";
import { ApiStatsTab } from "./components/tabs/ApiStatsTab";
import { FiltersTab } from "./components/tabs/FiltersTab";
import { MineTab } from "./components/tabs/MineTab";
import { ReviewedTab } from "./components/tabs/ReviewedTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { ToReviewTab } from "./components/tabs/ToReviewTab";
import { prmasterTauri } from "./lib/tauri";
import { useAiSummaryStore } from "./store/ai-summary-store";
import { usePrMasterStore } from "./store/prmaster-store";

const DEFAULT_TAB = "to-review";

interface TabDef {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  fullOnly?: boolean;
}

const TABS: TabDef[] = [
  { value: "to-review", icon: Inbox, label: "Review" },
  { value: "reviewed", icon: CheckCircle2, label: "Done" },
  { value: "mine", icon: User, label: "Mine" },
  { value: "filters", icon: Bell, label: "Filters", fullOnly: true },
  { value: "ai", icon: Sparkles, label: "AI", fullOnly: true },
  { value: "api", icon: BarChart3, label: "API", fullOnly: true },
  { value: "settings", icon: SettingsIcon, label: "Settings", fullOnly: true },
];

export function PRMasterShell() {
  // Detect on mount once — the window label can't change at runtime.
  const [isCompact] = useState(() => {
    try {
      return getCurrentWindow().label === "prmaster-popover";
    } catch {
      return false;
    }
  });

  // Tabs are controlled so the popover-reopen handler can snap us back
  // to Review without unmounting the rest of the tree.
  const [tab, setTab] = useState(DEFAULT_TAB);
  const { state, dispatch } = usePrMasterStore();

  const visible = useMemo(
    () => TABS.filter((t) => !t.fullOnly || !isCompact),
    [isCompact],
  );

  // Tab badge counts — only the three PR list tabs report a count;
  // Filters / AI / API / Settings stay numberless. A count of zero
  // hides the badge.
  const badgeFor = useCallback(
    (value: string): number => {
      switch (value) {
        case "to-review":
          return state.toReview.length;
        case "reviewed":
          return state.reviewed.length;
        case "mine":
          return state.mine.length;
        default:
          return 0;
      }
    },
    [state.toReview.length, state.reviewed.length, state.mine.length],
  );

  // Popover lifecycle (compact mode only):
  //   - On focus loss → ask the backend to hide the popover (matches
  //     the macOS `NSPopover` dismissal model).
  //   - On focus gain → treat that as "the user just reopened the
  //     popover" and reset the in-memory UI: jump back to Review and
  //     drop any half-opened detail panel. The first mount also fires
  //     this branch but the values are already at their defaults so
  //     it's a no-op visually.
  useEffect(() => {
    if (!isCompact) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await win.onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          void prmasterTauri.hidePopover();
        } else {
          setTab(DEFAULT_TAB);
          dispatch({ type: "select", id: null });
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [isCompact, dispatch]);

  // Keyboard navigation. `1`-`3` jump to the first three tabs (the
  // list tabs); arrows cycle through every visible tab. We only act
  // on bare keypresses (no modifiers) and ignore typing inside form
  // fields so the list/filter inputs keep working.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      const numericIdx = ["1", "2", "3"].indexOf(e.key);
      if (numericIdx >= 0) {
        const target = visible[numericIdx];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: null });
          setTab(target.value);
        }
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const idx = visible.findIndex((t) => t.value === tab);
        if (idx < 0) return;
        const next =
          e.key === "ArrowLeft"
            ? Math.max(0, idx - 1)
            : Math.min(visible.length - 1, idx + 1);
        if (next !== idx) {
          e.preventDefault();
          dispatch({ type: "select", id: null });
          setTab(visible[next]!.value);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, visible, dispatch]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Tabs
        value={tab}
        onValueChange={(v) => {
          // Switching tabs always drops the active detail panel — list
          // tabs share the same `selectedPrId` field in the store.
          dispatch({ type: "select", id: null });
          setTab(v);
        }}
        className="flex h-full min-h-0 flex-col"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
          <TabsList className="h-7 gap-0.5 bg-transparent p-0">
            {visible.map((t) => (
              <TabTrigger
                key={t.value}
                value={t.value}
                icon={t.icon}
                label={t.label}
                badge={badgeFor(t.value)}
                activity={t.value === "ai"}
              />
            ))}
          </TabsList>
          {!isCompact && (
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {state.currentUser && (
                <span className="font-mono">@{state.currentUser}</span>
              )}
              <span>
                <GitPullRequest className="mr-1 inline size-3" />
                PRMaster
              </span>
            </span>
          )}
        </div>

        <TabsContent value="to-review" className="flex min-h-0 flex-1 flex-col">
          <ToReviewTab />
        </TabsContent>
        <TabsContent value="reviewed" className="flex min-h-0 flex-1 flex-col">
          <ReviewedTab />
        </TabsContent>
        <TabsContent value="mine" className="flex min-h-0 flex-1 flex-col">
          <MineTab />
        </TabsContent>
        {!isCompact && (
          <>
            <TabsContent value="filters" className="flex min-h-0 flex-1 flex-col">
              <FiltersTab />
            </TabsContent>
            <TabsContent value="ai" className="flex min-h-0 flex-1 flex-col">
              <AiSummaryTab />
            </TabsContent>
            <TabsContent value="api" className="flex min-h-0 flex-1 flex-col">
              <ApiStatsTab />
            </TabsContent>
            <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col">
              <SettingsTab />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}

function TabTrigger({
  value,
  icon: Icon,
  label,
  badge,
  activity = false,
}: {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge: number;
  /** When true, this tab participates in the cross-tab "AI is
   *  generating" indicator — the icon flips to a spinner whenever the
   *  AI tab has work in flight, even if the user is on a different
   *  tab right now. Lets the user start a long generation, switch
   *  back to Review for a coffee, and still see at a glance that
   *  things are happening. */
  activity?: boolean;
}) {
  // The AI tab's `generating` flag lives in the hoisted summary store
  // alongside the rest of its state, so it survives every navigation
  // (tab switches *and* tool switches). We read it once for the
  // activity-flagged tab and let the spinner reflect work in flight
  // even when the user isn't on the AI tab.
  const { state: aiState } = useAiSummaryStore();
  const showSpinner = activity && aiState.generating;
  return (
    <TabsTrigger
      value={value}
      className={cn(
        "h-7 gap-1 rounded px-2 text-xs data-[state=active]:bg-accent",
        showSpinner && "text-primary",
      )}
      title={
        showSpinner
          ? "AI summary generation in progress"
          : undefined
      }
    >
      {showSpinner ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Icon className="size-3" />
      )}
      {label}
      {badge > 0 && (
        <span
          className={cn(
            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1",
            "bg-primary/15 text-[10px] font-medium leading-none text-primary",
          )}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </TabsTrigger>
  );
}
