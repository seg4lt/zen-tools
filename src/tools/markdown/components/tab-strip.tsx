/**
 * Tab strip rendered above the editor.
 *
 *   - Each tab shows the file basename, a `•` dot when dirty, and a
 *     close `×` that appears on hover (always visible on the active
 *     tab).
 *   - Click a tab to switch.  Middle-click closes (a power-user
 *     convention from VS Code/browsers).
 *   - Cmd+W closes the active tab — wired in `use-keyboard-nav.ts`.
 *
 * The strip is intentionally thin so it doesn't fight with the
 * editor for vertical room.
 */

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMarkdownStore } from "../store/markdown-store";
import { basenameNoExt } from "../lib/tauri";

export function TabStrip() {
  const { state, dispatch } = useMarkdownStore();

  if (state.tabs.length === 0) return null;

  return (
    <div className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b bg-card/40 px-1 pt-1">
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            onMouseDown={(e) => {
              if (e.button === 1) {
                // Middle click → close (VS Code convention).
                e.preventDefault();
                dispatch({ type: "closeTab", id: tab.id });
              }
            }}
            onClick={() => dispatch({ type: "selectTab", id: tab.id })}
            title={tab.path}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-1 rounded-t border border-b-0 px-2 text-xs",
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full transition-opacity",
                tab.dirty
                  ? "bg-amber-500 opacity-100"
                  : "bg-current opacity-0",
              )}
            />
            <span className="max-w-[160px] truncate">
              {basenameNoExt(tab.path)}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "closeTab", id: tab.id });
              }}
              aria-label={`Close ${basenameNoExt(tab.path)}`}
              title="Close (⌘W)"
              className={cn(
                "rounded-sm p-0.5 transition-opacity",
                "hover:bg-muted/60",
                active
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-70 group-hover:hover:opacity-100",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
