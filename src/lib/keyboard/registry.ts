/**
 * Lightweight global keybinding registry. Components register handlers
 * with `useShortcut("mod+e", () => ...)` and a single `window` listener
 * dispatches each keydown to the matching entries.
 *
 * By default, shortcuts are *suppressed* when the user is typing in an
 * editable surface (`<input>`, `<textarea>`, `contenteditable`, the
 * CodeMirror `.cm-content` host).  Pass `{ fireInInputs: true }` for
 * shortcuts that should always fire — e.g. `Cmd+P` / `Cmd+Shift+F`
 * search palette openers, since the user typically wants to switch
 * files while their cursor is parked in the editor.
 */

import { useEffect } from "react";
import { parseChord } from "./dsl";
import { matches, type KeyChord } from "./platform";

interface Entry {
  chord: KeyChord;
  handler: (event: KeyboardEvent) => void;
  fireInInputs: boolean;
}

const entries = new Set<Entry>();

let listenerAttached = false;

function attachListener() {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    let inEditable = false;
    if (target) {
      const tag = target.tagName.toUpperCase();
      inEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target.isContentEditable ||
        target.classList.contains("cm-content");
    }
    for (const entry of entries) {
      if (!matches(e, entry.chord)) continue;
      if (inEditable && !entry.fireInInputs) continue;
      e.preventDefault();
      e.stopPropagation();
      entry.handler(e);
      break;
    }
  });
}

export interface ShortcutOptions {
  /**
   * Whether this binding fires while focus is inside an editable
   * surface (input, textarea, contenteditable, CodeMirror host).
   * Default `false` — match the historical behaviour.  Set to `true`
   * for shortcuts that should always work (search palette openers,
   * mod+s save, etc.).
   */
  fireInInputs?: boolean;
}

/** Register a keybinding for the lifetime of the calling component. */
export function useShortcut(
  binding: string,
  handler: (e: KeyboardEvent) => void,
  enabled: boolean = true,
  options: ShortcutOptions = {},
): void {
  const fireInInputs = options.fireInInputs ?? false;
  useEffect(() => {
    if (!enabled) return;
    attachListener();
    const entry: Entry = {
      chord: parseChord(binding),
      handler,
      fireInInputs,
    };
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }, [binding, handler, enabled, fireInInputs]);
}
