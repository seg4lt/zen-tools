/**
 * Live-preview extension bundle.
 *
 * Exposes a single `livePreview()` factory that the editor mounts as
 * an Extension array.  Keeping the wiring in one place means the
 * editor component doesn't need to know about every internal bit
 * (view plugin, autocomplete sources, click handler).
 */

import "./style.css";
import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { livePreviewPlugin } from "./view-plugin";
import { mermaidField } from "./mermaid-field";
import { linkAutocompleteSource } from "./link-autocomplete";
import { linkClickHandler, wikilinkSource } from "./wikilink";

export interface LivePreviewOptions {
  /** Returns the directory of the currently-open `.md` file.  Used to
   *  resolve relative `![…](…)` paths into asset-protocol URLs and to
   *  shape link autocomplete suggestions as relative paths. */
  getDocDir: () => string;
  /** Returns the absolute path of the open document, or `null`. Used
   *  by the link autocomplete to give fff-search a ranking boost
   *  toward files near the open doc. */
  getCurrentPath: () => string | null;
  /** Returns every open vault root.  Forwarded to fff-search via
   *  `markdownTauri.searchFiles` for the link autocomplete. */
  getVaults: () => string[];
  /** Returns the active app theme.  Used by the embedded
   *  `*.excalidraw.svg` widget to re-export the drawing's SVG with
   *  the user's current colour scheme — without this, an SVG saved
   *  in light mode stays light when the app flips to dark. */
  getTheme: () => "light" | "dark";
  /** Returns every basename (no extension) the wikilink autocomplete
   *  should propose. */
  getWikilinkCandidates: () => string[];
  /** Called when the user `Mod+click`s a `[[wikilink]]` — the editor
   *  host resolves the label to a path and dispatches `openFile`. */
  onWikilinkOpen: (label: string) => void;
  /** Called when the user `Mod+click`s a standard `[label](url)`. The
   *  host decides whether to open in the editor (relative `.md`),
   *  open externally (`https://…`), or do nothing. */
  onLinkOpen: (url: string) => void;
}

/**
 * Build the Live-Preview extension array.
 *
 * Both autocomplete sources (wikilink + link path) are merged into a
 * **single** `autocompletion({ override: […] })` call.  Two parallel
 * `autocompletion()` extensions don't compose cleanly when each uses
 * `override`: CodeMirror picks one and shadows the other.  Combining
 * them here means each source returns `null` when its trigger
 * doesn't match and we get clean dispatch.
 */
export function livePreview(opts: LivePreviewOptions): Extension {
  return [
    livePreviewPlugin(opts.getDocDir, opts.getTheme),
    // Block-level decorations (mermaid diagram widget) — must come
    // from a state field, not a view plugin.
    mermaidField(),
    autocompletion({
      override: [
        wikilinkSource(opts.getWikilinkCandidates),
        linkAutocompleteSource(
          opts.getDocDir,
          opts.getVaults,
          opts.getCurrentPath,
        ),
      ],
      activateOnTyping: true,
    }),
    linkClickHandler({
      onWikilinkOpen: opts.onWikilinkOpen,
      onLinkOpen: opts.onLinkOpen,
    }),
  ];
}
