/**
 * Tab strip rendered above the editor.
 *
 * Visual design — matches the database-explorer editor-tab-strip so
 * every tab rail across the app reads as the same surface:
 *   - Strip is `bg-muted/60` with a single bottom border; tabs hang
 *     off the top edge with `rounded-t-md` corners.
 *   - The **active** tab lifts to `bg-background` (the editor surface
 *     directly below) so it visually merges with the editor body.
 *     No accent line — the surface lift alone reads as "selected".
 *   - Inactive tabs are transparent over the strip's deep tint, with
 *     a subtle hover state.
 *   - Each tab carries a file icon, the basename, an inline dirty dot
 *     when unsaved, and a hover-revealed close `×`. The close button
 *     stays visible on the active tab.
 *   - Tabs whose basename collides with another open tab grow a
 *     small dim subtitle showing their immediate parent directory,
 *     so the user can tell them apart without reading a tooltip.
 *
 * Keyboard:
 *   - Click → select.
 *   - Middle-click → close (browser convention).
 *   - `×` button → close.
 *   - `Cmd+W` / `Cmd+Opt+T` / `Cmd+1`..`9` / `Cmd+Alt+[`,`Cmd+Alt+]`
 *     are wired in `use-keyboard-nav.ts`.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AlertTriangle,
  BellDot,
  CheckCircle2,
  Code as CodeIcon,
  FileTerminal,
  FileText,
  Loader2,
  PenLine,
  X,
} from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import type { TabState } from "../store/markdown-store";
import { basename } from "../lib/tauri";

export interface TabStripProps {
  /** Global open tabs (shared across all splits). */
  tabs: TabState[];
  /** Tab id active in *this* tab strip. May differ across splits. */
  activeTabId: string | null;
  /** Click — host updates this leaf's active tab. */
  onSelect: (tabId: string) => void;
  /** X / middle-click — host removes the tab from `state.tabs`. */
  onClose: (tabId: string) => void;
}

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
}: TabStripProps) {
  // Build a `Map<tabId, dirSubtitle>` only for tabs whose basename
  // collides with another open tab.  Computed once per render.
  const subtitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      const name = tabLabel(tab).toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const out = new Map<string, string>();
    for (const tab of tabs) {
      const name = tabLabel(tab).toLowerCase();
      if ((counts.get(name) ?? 0) > 1) {
        if (tab.kind === "terminal") {
          const dir =
            tab.terminal?.cwdAbsolutePath ?? tab.terminal?.launchDirectory ?? null;
          const segs = dir?.split("/").filter(Boolean) ?? [];
          out.set(tab.id, segs.length >= 1 ? segs[segs.length - 1] ?? "" : "");
        } else {
          const segs = tab.path.split("/").filter(Boolean);
          out.set(tab.id, segs.length >= 2 ? segs[segs.length - 2] : "");
        }
      }
    }
    return out;
  }, [tabs]);

  // Auto-scroll the active tab into view when it changes.  Without
  // this, opening a deep file from the search palette can leave the
  // new tab off-screen on the right when many are open.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!activeTabId) return;
    const el = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${activeTabId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={stripRef}
      role="tablist"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/60 px-1.5 pt-1 text-[11px] [scrollbar-width:thin]"
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          subtitle={subtitles.get(tab.id) ?? null}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
        />
      ))}
    </div>
  );
}

interface TabProps {
  tab: TabState;
  active: boolean;
  subtitle: string | null;
  onSelect: () => void;
  onClose: () => void;
}

function Tab({ tab, active, subtitle, onSelect, onClose }: TabProps) {
  const name = tabLabel(tab);
  const Icon =
    tab.kind === "terminal"
      ? FileTerminal
      : tab.kind === "excalidraw"
      ? PenLine
      : tab.kind === "html"
        ? CodeIcon
        : FileText;
  const terminalStatus = tab.terminal?.status ?? null;
  const terminalPhase = tab.terminal?.phase ?? null;
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      onMouseDown={(e) => {
        if (e.button === 1) {
          // Middle-click closes (VS Code / browser convention).
          e.preventDefault();
          onClose();
        }
      }}
      onClick={onSelect}
      title={tab.path}
      className={cn(
        "group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-1.5 transition",
        active
          ? "bg-background text-foreground"
          : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          active && tab.kind === "terminal"
            ? "text-sky-500/90"
            : active && tab.kind === "excalidraw"
            ? "text-violet-500/90"
            : active && tab.kind === "html"
              ? "text-orange-500/90"
              : undefined,
        )}
      />

      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          active ? "font-medium" : "font-normal",
        )}
      >
        {name}
      </span>

      {subtitle ? (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/55">
          {subtitle}
        </span>
      ) : null}

      {tab.dirty ? (
        <span
          aria-hidden
          className="ml-0.5 inline-block size-1.5 shrink-0 rounded-full bg-foreground/80"
          title="Unsaved changes"
        />
      ) : null}

      {terminalPhase && terminalStatus ? (
        <TerminalStatusBadge phase={terminalPhase} status={terminalStatus} />
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
        title="Close (⌘W)"
        className={cn(
          "h-4 w-4 shrink-0 p-0 transition",
          active
            ? "opacity-70 hover:opacity-100"
            : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

function tabLabel(tab: TabState): string {
  if (tab.kind === "terminal") {
    return tab.terminal?.title?.trim() || "shell";
  }
  return basename(tab.path);
}

function TerminalStatusBadge({
  phase,
  status,
}: {
  phase: NonNullable<TabState["terminal"]>["phase"];
  status: NonNullable<TabState["terminal"]>["status"];
}) {
  if (phase === "pending") {
    return (
      <span title="Starting terminal">
        <Loader2 className="size-3 shrink-0 animate-spin text-sky-500" />
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span title={status.lastNoticeMessage ?? "Terminal failed to start"}>
        <AlertTriangle className="size-3 shrink-0 text-red-500" />
      </span>
    );
  }
  if (status.actionRequired) {
    return (
      <span title="Action required">
        <AlertTriangle className="size-3 shrink-0 text-orange-500" />
      </span>
    );
  }
  if (status.unhealthy) {
    return (
      <span title="Renderer unhealthy">
        <AlertTriangle className="size-3 shrink-0 text-red-500" />
      </span>
    );
  }
  if (status.loading || status.paused) {
    return (
      <span title={status.loading ? "Command running" : "Command paused"}>
        <Loader2
          className={cn(
            "size-3 shrink-0",
            status.loading ? "animate-spin text-sky-500" : "text-amber-500",
          )}
        />
      </span>
    );
  }
  if (status.completed) {
    return (
      <span title="Command completed">
        <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
      </span>
    );
  }
  if (status.unreadCount > 0) {
    return (
      <span
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sky-500/15 px-1 text-[10px] font-medium text-sky-700 dark:text-sky-300"
        title={status.lastNoticeMessage ?? "Terminal notification"}
      >
        {status.unreadCount > 9 ? "9+" : status.unreadCount}
      </span>
    );
  }
  return (
    <span title="Terminal tab">
      <BellDot className="size-3 shrink-0 text-muted-foreground/40" />
    </span>
  );
}
