/**
 * Lightweight global keybinding registry. Components register handlers
 * with `useShortcut("mod+e", () => ...)` and a single `window` listener
 * dispatches each keydown to the matching entries.
 */

import { useEffect } from "react";
import { parseChord } from "./dsl";
import { matches, type KeyChord } from "./platform";

interface Entry {
  chord: KeyChord;
  handler: (event: KeyboardEvent) => void;
}

const entries = new Set<Entry>();

let listenerAttached = false;

function attachListener() {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener("keydown", (e) => {
    // Skip while the user is typing in an editable surface.
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName.toUpperCase();
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target.isContentEditable ||
        target.classList.contains("cm-content")
      ) {
        return;
      }
    }
    for (const entry of entries) {
      if (matches(e, entry.chord)) {
        e.preventDefault();
        entry.handler(e);
        break;
      }
    }
  });
}

/** Register a keybinding for the lifetime of the calling component. */
export function useShortcut(
  binding: string,
  handler: (e: KeyboardEvent) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    attachListener();
    const entry: Entry = { chord: parseChord(binding), handler };
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }, [binding, handler, enabled]);
}
