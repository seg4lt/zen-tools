/**
 * Tab strip rendered above the editor.
 *
 * Visual design (VS-Code-flavoured):
 *   - The strip itself sits on a dim `bg-muted/20` with a single
 *     bottom border.
 *   - The **active** tab's background matches the editor below
 *     (`bg-background`) so it visually merges into the editor; a
 *     slim primary-colored accent line sits on top.
 *   - Inactive tabs are transparent over the strip's dim bg, with a
 *     hover state that brightens them.
 *   - Each tab carries a file icon, the basename, and a hover-aware
 *     close affordance.  When the file is dirty, the close `×` is
 *     replaced by an amber `•` until the user hovers (then the `×`
 *     comes back so they can still close it).
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
import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
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
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/20 [scrollbar-width:thin]"
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
        "group relative flex min-w-[120px] max-w-[220px] shrink cursor-pointer items-center gap-1.5 border-r border-border/30 pl-3 pr-2 text-xs transition-colors",
        active
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      {/* Active accent — sits at the very top edge of the tab.
          Inactive tabs render an invisible spacer of the same height
          so toggling active doesn't reflow neighbours. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-[2px]",
          active ? "bg-primary" : "bg-transparent",
        )}
      />

      <FileText
        className={cn(
          "size-3.5 shrink-0",
          active ? "text-primary/80" : "text-muted-foreground/60",
        )}
      />

      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>

      {subtitle ? (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/55">
          {subtitle}
        </span>
      ) : null}

      <CloseAffordance
        dirty={tab.dirty}
        active={active}
        onClose={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
    </div>
  );
}

interface CloseAffordanceProps {
  dirty: boolean;
  active: boolean;
  onClose: (e: React.MouseEvent) => void;
}

/**
 * Renders either:
 *   - dirty + not hovered → amber `•`
 *   - dirty + hovered     → `×`
 *   - clean + active      → `×` at low opacity, hover bumps it up
 *   - clean + inactive    → `×` hidden, appears on tab hover
 *
 * Click always closes; the dot itself is part of the close button so
 * a single click on either glyph performs the close.
 */
function CloseAffordance({ dirty, active, onClose }: CloseAffordanceProps) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close tab"
      title="Close (⌘W)"
      className="relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted/60"
    >
      {dirty ? (
        <>
          <span
            aria-hidden
            className="size-2 rounded-full bg-amber-500 group-hover:hidden"
          />
          <X
            aria-hidden
            className="hidden size-3 text-muted-foreground group-hover:block hover:text-foreground"
          />
        </>
      ) : (
        <X
          aria-hidden
          className={cn(
            "size-3 transition-opacity",
            active
              ? "opacity-50 hover:opacity-100"
              : "opacity-0 group-hover:opacity-50 hover:opacity-100",
          )}
        />
      )}
    </button>
  );
}
