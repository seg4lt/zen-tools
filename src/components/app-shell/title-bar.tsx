import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CircleHelp, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { ToolPill } from "./tool-pill";
import { isMac, useShortcut } from "@zen-tools/keyboard";
import { useAppZoom } from "@/hooks/use-app-zoom";
import { useLastRoute } from "@/hooks/use-last-route";
import { useToolOrder } from "@/hooks/use-tool-order";
import { useUpdater } from "@/lib/updater/use-updater";
import {
  applyTerminalToolStatus,
  emptyTerminalToolTabState,
  summarizeTerminalToolAttention,
  type TerminalToolTabState,
} from "@/tools/terminal/lib/attention";
import {
  onTabClosed,
  onTabFocused,
  onTerminalStatus,
} from "@/tools/terminal/lib/tauri";

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
  const onShortcuts = location.pathname.startsWith("/shortcuts");

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
              (existing.unreadCount === 0 && !existing.actionRequired)
            ) {
              return current;
            }
            return {
              ...current,
              [payload.id]: {
                ...existing,
                actionRequired: false,
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

      {/* Right group — shortcut help and Settings. Theme + Vim toggles
          (and zoom) live inside the settings page. */}
      <div
        className="ml-auto flex items-center gap-1"
        // Stop the drag region from swallowing pointer events on this group.
        data-tauri-drag-region={false}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Keyboard shortcuts"
          aria-pressed={onShortcuts}
          onClick={() => void navigate({ to: "/shortcuts" })}
          className={
            "size-7 " +
            (onShortcuts ? "bg-muted text-foreground" : "")
          }
          title="Keyboard shortcuts"
        >
          <CircleHelp className="size-4" />
        </Button>
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
