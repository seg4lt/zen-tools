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

  // Hide-on-blur for the popover (matches macOS `NSPopover` dismissal).
  // Routed through the backend so the tray's next click reopens it cleanly.
  useEffect(() => {
    if (!isCompact) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await win.onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          void invoke("prmaster_hide_popover");
        }
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [isCompact]);

  const visible = useMemo(
    () => TABS.filter((t) => !t.fullOnly || !isCompact),
    [isCompact],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Tabs defaultValue="mine" className="flex h-full min-h-0 flex-col">
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
