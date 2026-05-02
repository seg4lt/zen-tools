/**
 * PRMaster — top-level shell.
 *
 * Mirrors the Swift `MainView` layout but composes shadcn `Tabs` instead of a
 * custom `MainTabBar`. Two tab inventories:
 *
 *   - **Compact** (menu-bar popover): Review · Done · Mine · Conv —
 *     matches PRMaster's `MenuBarExtra` 4-tab layout.
 *   - **Full** (main window): adds Filters · AI · API · Settings.
 *
 * Window detection happens via `getCurrentWindow().label`; the popover
 * also dismisses on blur (mirrors macOS `NSPopover` behaviour).
 */

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Bell,
  CheckCircle2,
  GitPullRequest,
  Inbox,
  MessageSquare,
  Settings as SettingsIcon,
  Sparkles,
  User,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiSummaryTab } from "./components/tabs/AiSummaryTab";
import { ApiStatsTab } from "./components/tabs/ApiStatsTab";
import { ConversationsTab } from "./components/tabs/ConversationsTab";
import { FiltersTab } from "./components/tabs/FiltersTab";
import { MineTab } from "./components/tabs/MineTab";
import { ReviewedTab } from "./components/tabs/ReviewedTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { ToReviewTab } from "./components/tabs/ToReviewTab";
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
  { value: "conversations", icon: MessageSquare, label: "Conv" },
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
  const { dispatch } = usePrMasterStore();

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
          void invoke("prmaster_hide_popover");
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

  const visible = useMemo(
    () => TABS.filter((t) => !t.fullOnly || !isCompact),
    [isCompact],
  );

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
              />
            ))}
          </TabsList>
          {!isCompact && (
            <span className="ml-auto text-xs text-muted-foreground">
              <GitPullRequest className="mr-1 inline size-3" />
              PRMaster
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
        <TabsContent value="conversations" className="flex min-h-0 flex-1 flex-col">
          <ConversationsTab />
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
}: {
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger
      value={value}
      className="h-7 gap-1 rounded px-2 text-xs data-[state=active]:bg-accent"
    >
      <Icon className="size-3" />
      {label}
    </TabsTrigger>
  );
}
