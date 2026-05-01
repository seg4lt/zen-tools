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
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

/**
 * Wikilink completion source — fires when the cursor sits inside an
 * unmatched `[[`.  Exported as a bare [`CompletionSource`] (not a
 * full `autocompletion({…})` extension) so the live-preview index
 * can merge it with the markdown-link source under a *single*
 * `autocompletion()` call; two parallel ones would shadow each
 * other's `override` arrays.
 *
 * `getCandidates` returns the universe of suggestions each time the
 * user types `[[`.  It's a callback so the live-preview module
 * doesn't have to know about the store — the markdown editor wires
 * it up.
 */
export function wikilinkSource(getCandidates: () => string[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
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
  };
}

/**
 * Click handler — `Mod+click` on either a `.cm-md-wikilink` span (the
 * `[[…]]` flavour) or a `.cm-md-link` span (the standard
 * `[label](url)` flavour) routes the click to the matching callback.
 * Bare clicks still place the cursor.  Attached via
 * `EditorView.domEventHandlers` so the listener lifecycles with the
 * editor.
 */
export function linkClickHandler(opts: {
  onWikilinkOpen: (label: string) => void;
  onLinkOpen: (url: string) => void;
}) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      // Mod-click only — bare clicks let the user place the cursor.
      const isMod = navigator.platform.toLowerCase().includes("mac")
        ? event.metaKey
        : event.ctrlKey;
      if (!isMod) return;
      const target = event.target as HTMLElement | null;
      // Wikilinks first — they're inside the same DOM tree as links
      // can nest in (rare but possible), so the more-specific class
      // wins.
      const wikilink = target?.closest<HTMLElement>(".cm-md-wikilink");
      if (wikilink) {
        const label = wikilink.dataset.wikilink ?? wikilink.textContent ?? "";
        if (!label) return;
        event.preventDefault();
        opts.onWikilinkOpen(label.trim());
        return;
      }
      const link = target?.closest<HTMLElement>(".cm-md-link");
      if (link) {
        const url = link.dataset.linkUrl ?? "";
        if (!url) return;
        event.preventDefault();
        opts.onLinkOpen(url);
      }
    },
  });
}
