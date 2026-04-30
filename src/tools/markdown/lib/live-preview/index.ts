/**
 * Live-preview extension bundle.
 *
 * Exposes a single `livePreview()` factory that the editor mounts as
 * an Extension array.  Keeping the wiring in one place means the
 * editor component doesn't need to know about every internal bit
 * (view plugin, autocomplete source, click handler).
 */

import "./style.css";
import type { Extension } from "@codemirror/state";
import { livePreviewPlugin } from "./view-plugin";
import { wikilinkAutocomplete, wikilinkClickHandler } from "./wikilink";

export interface LivePreviewOptions {
  /** Returns the directory of the currently-open `.md` file.  Used to
   *  resolve relative `![…](…)` paths into asset-protocol URLs. */
  getDocDir: () => string;
  /** Returns every basename (no extension) the wikilink autocomplete
   *  should propose. */
  getWikilinkCandidates: () => string[];
  /** Called when the user `Mod+click`s a wikilink — the editor host
   *  resolves the label to a path and dispatches `openFile`. */
  onWikilinkOpen: (label: string) => void;
}

/**
 * Build the Live-Preview extension array.  Order matters only for
 * autocomplete — we put it before the click handler so the
 * domEventHandlers bound below see the latest selection.
 */
export function livePreview(opts: LivePreviewOptions): Extension {
  return [
    livePreviewPlugin(opts.getDocDir),
    wikilinkAutocomplete(opts.getWikilinkCandidates),
    wikilinkClickHandler(opts.onWikilinkOpen),
  ];
}
