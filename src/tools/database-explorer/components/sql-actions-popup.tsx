/**
 * Floating "context actions" popup for the SQL editor.
 *
 * Triggered by `Opt+Enter` (Mac) / `Alt+Enter` (Linux/Win) on a token in
 * the editor. Renders a small `cmdk`-backed list of actions positioned
 * near the cursor; the most common actions are reindexing the table at
 * the cursor or every table referenced in the current statement.
 *
 * The popup owns its own escape / outside-click handling. The parent
 * editor merely controls visibility and refocuses the editor when we
 * close.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface SqlAction {
  /** Stable id for keyed React rendering. */
  id: string;
  /** Label shown to the user. Backticks render as inline code. */
  label: string;
  /** Async work to perform when the user picks this entry. */
  run: () => Promise<void> | void;
}

export interface SqlActionsPopupProps {
  /** Viewport-relative pixel coords of the cursor position. */
  x: number;
  y: number;
  actions: SqlAction[];
  onClose: () => void;
}

/**
 * Width of the popup in pixels. Matched against the available
 * viewport width so the popup never overflows when the cursor is near
 * the right edge.
 */
const POPUP_WIDTH = 360;

export function SqlActionsPopup({
  x,
  y,
  actions,
  onClose,
}: SqlActionsPopupProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-click and Escape both close. Mounted once because the
  // popup is a singleton at any given time.
  useEffect(() => {
    const onPointer = (ev: MouseEvent) => {
      const node = rootRef.current;
      if (!node) return;
      if (ev.target instanceof Node && node.contains(ev.target)) return;
      onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Keep the popup inside the viewport. We clamp `left` so the right
  // edge doesn't get cut off, and flip above the cursor when the
  // bottom would clip.
  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight =
    typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.min(x, viewportWidth - POPUP_WIDTH - 8);
  const willOverflowBottom = y + 240 > viewportHeight;
  const top = willOverflowBottom ? Math.max(8, y - 240) : y;

  const node = (
    <div
      ref={rootRef}
      className="fixed z-50 rounded-md border border-border/60 bg-popover text-popover-foreground shadow-lg"
      style={{ left, top, width: POPUP_WIDTH }}
      // CodeMirror's vim plugin steals every keystroke off `window`
      // unless the popup explicitly stops propagation; cmdk needs the
      // arrow keys for navigation.
      onKeyDownCapture={(ev) => {
        ev.stopPropagation();
      }}
    >
      <Command>
        <CommandInput placeholder="Type to filter actions…" autoFocus />
        <CommandList>
          <CommandEmpty>No matching actions.</CommandEmpty>
          <CommandGroup heading="Schema cache">
            {actions.map((action) => (
              <CommandItem
                key={action.id}
                onSelect={() => {
                  // Close first so the editor regains focus before any
                  // refresh-triggered re-render lands.
                  onClose();
                  Promise.resolve(action.run()).catch(() => {
                    // Soft-fail — surface via tracing in a future
                    // revision; for now we just don't crash the UI.
                  });
                }}
              >
                {renderLabel(action.label)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );

  return createPortal(node, document.body);
}

/** Render labels with `\`code\`` segments wrapped in `<code>`. */
function renderLabel(label: string) {
  const parts = label.split("`");
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <code
        key={idx}
        className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
      >
        {part}
      </code>
    ) : (
      <span key={idx}>{part}</span>
    ),
  );
}
