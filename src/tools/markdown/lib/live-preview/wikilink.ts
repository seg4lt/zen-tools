/**
 * Wikilink (`[[Note Name]]`) extras for the markdown editor.
 *
 *   1. Autocomplete: when the cursor sits inside an unmatched `[[`,
 *      suggest every `.md` basename across the open vaults.
 *   2. Click handler: a `Mod+click` (Cmd on macOS, Ctrl elsewhere) on
 *      a `.cm-md-wikilink`-decorated span dispatches a navigation
 *      callback.  The decoration class is applied by the live-preview
 *      ViewPlugin in `view-plugin.ts`.
 */

import {
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

/**
 * `getCandidates` returns the universe of completion candidates each
 * time the user types `[[`.  It's a callback so the editor doesn't
 * need to know about the store directly — the markdown editor wires
 * it up.
 */
export function wikilinkAutocomplete(getCandidates: () => string[]) {
  return autocompletion({
    override: [
      (ctx: CompletionContext): CompletionResult | null => {
        // Find the unmatched `[[` to the left of the cursor.
        const line = ctx.state.doc.lineAt(ctx.pos);
        const before = ctx.state.doc.sliceString(line.from, ctx.pos);
        const open = before.lastIndexOf("[[");
        if (open === -1) return null;
        // If a closing `]]` already follows on the same line we're not
        // inside an open wikilink — bail out.
        const between = before.slice(open + 2);
        if (between.includes("]]") || between.includes("\n")) return null;
        const from = line.from + open + 2;
        const candidates = getCandidates();
        if (candidates.length === 0) return null;
        return {
          from,
          to: ctx.pos,
          options: candidates.map((name) => ({
            label: name,
            apply: `${name}]]`,
            type: "text",
          })),
          // Tell CodeMirror to validate against this regex on each
          // keystroke; saves us recomputing options character-by-character.
          validFor: /^[^\[\]\n]*$/,
        };
      },
    ],
    activateOnTyping: true,
  });
}

/**
 * Click handler — bind `Mod+click` on a `.cm-md-wikilink` span to a
 * navigation callback.  We attach via `EditorView.domEventHandlers`
 * so the listener lifecycles with the editor.
 */
export function wikilinkClickHandler(onOpen: (label: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      // Mod-click only — bare clicks let the user place the cursor.
      const isMod =
        navigator.platform.toLowerCase().includes("mac")
          ? event.metaKey
          : event.ctrlKey;
      if (!isMod) return;
      const target = event.target as HTMLElement | null;
      const link = target?.closest<HTMLElement>(".cm-md-wikilink");
      if (!link) return;
      const label = link.dataset.wikilink ?? link.textContent ?? "";
      if (!label) return;
      event.preventDefault();
      onOpen(label.trim());
    },
  });
}
