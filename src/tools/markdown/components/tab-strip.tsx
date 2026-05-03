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
import { FileText, PenLine, X } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useMarkdownStore, type TabState } from "../store/markdown-store";
import { basenameNoExt } from "../lib/tauri";

export function TabStrip() {
  const { state, dispatch } = useMarkdownStore();

  // Build a `Map<tabId, dirSubtitle>` only for tabs whose basename
  // collides with another open tab.  Computed once per render.
  const subtitles = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of state.tabs) {
      const name = basenameNoExt(tab.path).toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const out = new Map<string, string>();
    for (const tab of state.tabs) {
      const name = basenameNoExt(tab.path).toLowerCase();
      if ((counts.get(name) ?? 0) > 1) {
        const segs = tab.path.split("/").filter(Boolean);
        out.set(tab.id, segs.length >= 2 ? segs[segs.length - 2] : "");
      }
    }
    return out;
  }, [state.tabs]);

  // Auto-scroll the active tab into view when it changes.  Without
  // this, opening a deep file from the search palette can leave the
  // new tab off-screen on the right when many are open.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!state.activeTabId) return;
    const el = stripRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${state.activeTabId}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeTabId]);

  if (state.tabs.length === 0) return null;

  return (
    <div
      ref={stripRef}
      role="tablist"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-muted/60 px-1.5 pt-1 text-[11px] [scrollbar-width:thin]"
    >
      {state.tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === state.activeTabId}
          subtitle={subtitles.get(tab.id) ?? null}
          onSelect={() => dispatch({ type: "selectTab", id: tab.id })}
          onClose={() => dispatch({ type: "closeTab", id: tab.id })}
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
  const name = basenameNoExt(tab.path);
  const Icon = tab.kind === "excalidraw" ? PenLine : FileText;
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
          active && tab.kind === "excalidraw"
            ? "text-violet-500/90"
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
