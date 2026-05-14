import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Settings as SettingsIcon } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { ToolPill, type ToolPillAttention } from "./tool-pill";
import { isMac, useShortcut } from "@zen-tools/keyboard";
import { useAppZoom } from "@/hooks/use-app-zoom";
import { useLastRoute } from "@/hooks/use-last-route";
import { useToolOrder } from "@/hooks/use-tool-order";
import { useUpdater } from "@/lib/updater/use-updater";
import {
  onTabClosed,
  onTabFocused,
  onTerminalStatus,
  type TerminalStatusEvent,
} from "@/tools/terminal/lib/tauri";

interface TerminalToolTabState {
  loading: boolean;
  paused: boolean;
  actionRequired: boolean;
  completed: boolean;
  unreadCount: number;
  unhealthy: boolean;
  progress: number | null;
}

function emptyTerminalToolTabState(): TerminalToolTabState {
  return {
    loading: false,
    paused: false,
    actionRequired: false,
    completed: false,
    unreadCount: 0,
    unhealthy: false,
    progress: null,
  };
}

function applyTerminalToolStatus(
  current: TerminalToolTabState,
  event: TerminalStatusEvent,
): TerminalToolTabState {
  switch (event.kind) {
    case "progress":
      if (event.state === "remove") {
        return { ...current, loading: false, paused: false, progress: null };
      }
      if (event.state === "error") {
        return {
          ...current,
          loading: false,
          paused: false,
          completed: false,
          progress: event.progress,
          unreadCount: current.unreadCount + 1,
        };
      }
      return {
        ...current,
        loading: event.state === "set" || event.state === "indeterminate",
        paused: event.state === "pause",
        completed: false,
        progress: event.progress,
      };
    case "desktop-notification":
    case "child-exited":
      return {
        ...current,
        actionRequired: true,
        completed: false,
        unreadCount: current.unreadCount + 1,
      };
    case "bell":
      return {
        ...current,
        unreadCount: current.unreadCount + 1,
      };
    case "interaction":
      return {
        ...current,
        actionRequired: false,
        completed: false,
        unreadCount: 0,
      };
    case "command-finished":
      return {
        ...current,
        loading: false,
        paused: false,
        completed: true,
        unreadCount: current.unreadCount + 1,
      };
    case "renderer-health":
      return { ...current, unhealthy: !event.healthy };
  }
}

function summarizeTerminalToolAttention(
  tabs: Record<number, TerminalToolTabState>,
): ToolPillAttention | null {
  const values = Object.values(tabs);
  if (values.length === 0) return null;
  const loadingCount = values.filter((tab) => tab.loading).length;
  const pausedCount = values.filter((tab) => tab.paused).length;
  const actionRequiredCount = values.filter((tab) => tab.actionRequired).length;
  const completedCount = values.filter((tab) => tab.completed).length;
  const unreadCount = values.reduce((sum, tab) => sum + tab.unreadCount, 0);
  const unhealthyCount = values.filter((tab) => tab.unhealthy).length;
  const maxProgress = values.reduce<number | null>(
    (max, tab) =>
      tab.progress == null ? max : max == null ? tab.progress : Math.max(max, tab.progress),
    null,
  );
  if (
    loadingCount === 0 &&
    pausedCount === 0 &&
    actionRequiredCount === 0 &&
    completedCount === 0 &&
    unreadCount === 0 &&
    unhealthyCount === 0
  ) {
    return null;
  }
  return {
    loading: loadingCount > 0,
    actionRequired: actionRequiredCount > 0,
    completed: completedCount > 0,
    unread: unreadCount > 0,
    unhealthy: unhealthyCount > 0,
    label:
      actionRequiredCount > 0
        ? `Action required in ${actionRequiredCount} pane${actionRequiredCount === 1 ? "" : "s"}`
        : unhealthyCount > 0
        ? `Renderer unhealthy in ${unhealthyCount} pane${unhealthyCount === 1 ? "" : "s"}`
        : loadingCount > 0
          ? maxProgress != null && loadingCount === 1
            ? `Loading ${maxProgress}%`
            : `Loading in ${loadingCount} pane${loadingCount === 1 ? "" : "s"}`
          : completedCount > 0
            ? `Completed in ${completedCount} pane${completedCount === 1 ? "" : "s"}`
          : pausedCount > 0
            ? `Paused in ${pausedCount} pane${pausedCount === 1 ? "" : "s"}`
            : `${unreadCount} terminal notification${unreadCount === 1 ? "" : "s"}`,
  };
}

/**
 * Top bar with traffic-light gap on the left (macOS only), segmented
 * tool pills, and action group on the right (Settings icon).
 *
 * Acts as the always-mounted host for three app-shell-wide concerns
 * that don't have a dedicated provider component:
 *
 *  - global zoom level + ⌘=/⌘−/⌘0 keybindings (`useAppZoom`)
 *  - last-active-route writer (`useLastRoute`) used by the index
 *    redirect to resume on relaunch
 *  - tool-pill ordering pulled from `preferences.toolOrder`
 *    (`useToolOrder`)
 */
export function TitleBar() {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const { tools } = useToolOrder();
  const activeToolId = tools.find((t) =>
    location.pathname.startsWith(t.route),
  )?.id;
  const onSettings = location.pathname.startsWith("/settings");

  // Apply persisted zoom + bind ⌘= / ⌘− / ⌘0 globally. `fireInInputs`
  // because the registry otherwise drops shortcuts while focus is in
  // any editable surface (CodeMirror, inputs, contenteditables) —
  // and zoom *must* work everywhere, including in vim/normal mode.
  //
  // DSL note: parseChord splits on `+`, so we use the `plus` alias for
  // the literal `+` key. `mod+=` matches Cmd+= without Shift (the
  // standard browser zoom-in chord); `mod+shift+plus` matches Cmd+
  // Shift+= which produces `e.key === "+"`.
  const { zoomIn, zoomOut, reset } = useAppZoom();
  useShortcut("mod+=", zoomIn, true, { fireInInputs: true });
  useShortcut("mod+shift+plus", zoomIn, true, { fireInInputs: true });
  useShortcut("mod+-", zoomOut, true, { fireInInputs: true });
  useShortcut("mod+0", reset, true, { fireInInputs: true });

  // Persist current pathname → localStorage on every navigation, so
  // the index route can resume on the same page next launch.
  useLastRoute();

  // Yellow dot on the Settings icon when an update is waiting (and the
  // user hasn't yet visited Settings to act on it). The dot stays on
  // even after dismissing the banner — Settings is the canonical place
  // to see/install updates, so the dot persists until they install.
  const { state: updaterState } = useUpdater();
  const hasUpdate = updaterState.status === "available";
  const [terminalTabs, setTerminalTabs] = useState<
    Record<number, TerminalToolTabState>
  >({});
  const terminalAttention = useMemo(
    () => summarizeTerminalToolAttention(terminalTabs),
    [terminalTabs],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisteners: Array<() => void> = [];
    void (async () => {
      const subs = await Promise.all([
        onTerminalStatus((event) => {
          setTerminalTabs((current) => {
            const existing = current[event.id] ?? emptyTerminalToolTabState();
            return {
              ...current,
              [event.id]: applyTerminalToolStatus(existing, event),
            };
          });
        }),
        onTabFocused((payload) => {
          setTerminalTabs((current) => {
            const existing = current[payload.id];
            if (
              !existing ||
              (existing.unreadCount === 0 &&
                !existing.actionRequired &&
                !existing.completed)
            ) {
              return current;
            }
            return {
              ...current,
              [payload.id]: {
                ...existing,
                actionRequired: false,
                completed: false,
                unreadCount: 0,
              },
            };
          });
        }),
        onTabClosed((payload) => {
          setTerminalTabs((current) => {
            if (!(payload.id in current)) return current;
            const next = { ...current };
            delete next[payload.id];
            return next;
          });
        }),
      ]);
      if (cancelled) {
        for (const unlisten of subs) unlisten();
      } else {
        unlisteners = subs;
      }
    })();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur-sm"
    >
      {/* macOS overlay style draws traffic lights in this region. On
          other platforms there's nothing here so reclaim the space. */}
      {isMac && <div className="w-16 shrink-0" data-tauri-drag-region />}

      {/* Segmented tool pills, ordered per user preference. */}
      <div className="flex h-7 items-center gap-1 rounded-md bg-muted/50 p-0.5">
        {tools.map((tool) => (
          <ToolPill
            key={tool.id}
            tool={tool}
            active={tool.id === activeToolId}
            attention={tool.id === "terminal" ? terminalAttention : null}
          />
        ))}
      </div>

      {/* Right group — single Settings icon. Theme + Vim toggles
          (and zoom) live inside the settings page. */}
      <div
        className="ml-auto flex items-center gap-1"
        // Stop the drag region from swallowing pointer events on this group.
        data-tauri-drag-region={false}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={hasUpdate ? "Settings (update available)" : "Settings"}
          aria-pressed={onSettings}
          onClick={() => void navigate({ to: "/settings" })}
          className={
            "relative size-7 " +
            (onSettings ? "bg-muted text-foreground" : "")
          }
          title={hasUpdate ? "Settings — update available" : "Settings"}
        >
          <SettingsIcon className="size-4" />
          {hasUpdate && (
            <span
              aria-hidden
              className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-amber-400 ring-1 ring-card"
            />
          )}
        </Button>
      </div>
    </header>
  );
}
