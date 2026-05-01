/**
 * Markdown-link path autocomplete — fires when the cursor sits
 * inside the `(…)` of a `[label](query)` (or `![alt](query)` image)
 * and the user is partway through typing the path.
 *
 * Trigger detection: scan the current line back for the most recent
 * `](` and bail if there's a `)` between it and the cursor.  We
 * intentionally don't try to validate that a matching `[` exists
 * earlier on the line — `](` is rare enough as a non-link sequence
 * that false positives are harmless, and constraining to a single
 * line avoids accidentally triggering inside multi-line code blocks
 * or HTML.
 *
 * Result population: hand the partial path off to fff-search via
 * `markdownTauri.searchFiles`.  fff returns ranked **absolute** paths
 * across every open vault; we map each to a relative path against
 * the open document's directory before inserting, so users get the
 * familiar `subdir/note.md` form rather than `/Users/.../subdir/note.md`.
 *
 * Implementation note: this exports a bare [`CompletionSource`] —
 * the live-preview `index.ts` merges it with the wikilink source
 * under a single `autocompletion({…})` call so the two don't shadow
 * each other's `override` arrays.
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { basename, markdownTauri, posixRelative } from "../tauri";

/** Cap on the number of suggestions surfaced — fff returns up to
 *  ~200 ranked paths; surfacing more than this in a popup just
 *  wastes screen real estate and CodeMirror filters interactively
 *  anyway. */
const LINK_SUGGESTION_LIMIT = 30;

/** Constructs the link-path completion source.
 *
 *  @param getDocDir       Returns the absolute directory of the open
 *                         document — used to compute relative paths.
 *                         Empty string when no doc is open (we then
 *                         emit the absolute path as-is).
 *  @param getVaults       Returns every open vault root.  Forwarded
 *                         to `markdownTauri.searchFiles`.
 *  @param getCurrentFile  Returns the absolute path of the active
 *                         document, or `null`.  Used as a ranking
 *                         boost so files near the open doc score
 *                         higher.
 */
export function linkAutocompleteSource(
  getDocDir: () => string,
  getVaults: () => string[],
  getCurrentFile: () => string | null,
): CompletionSource {
  return async (
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> => {
    // Same-line scan — multi-line markdown link paths aren't a thing
    // and skipping the broader cursor walk avoids false triggers
    // inside embedded HTML blocks.
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = ctx.state.doc.sliceString(line.from, ctx.pos);
    const open = before.lastIndexOf("](");
    if (open === -1) return null;

    // If the user already typed a closing paren on this line between
    // `](` and the cursor, we're past the link target — bail.
    const between = before.slice(open + 2);
    if (between.includes(")")) return null;

    // Don't fire when the user has nothing useful for fff — both
    // saves an IPC round-trip on every keystroke after the bare `](`
    // and avoids dumping 200 paths into a popup before the user has
    // typed anything filterable.  CodeMirror still re-invokes us as
    // soon as the first character lands.
    //
    // Exception: if the user *explicitly* invokes completion (e.g.
    // Ctrl-Space) we surface everything — that's `ctx.explicit`.
    if (between.length === 0 && !ctx.explicit) return null;

    const from = line.from + open + 2;
    const vaults = getVaults();
    if (vaults.length === 0) return null;

    let absPaths: string[];
    try {
      absPaths = await markdownTauri.searchFiles(
        vaults,
        between,
        getCurrentFile(),
      );
    } catch (err) {
      // Tauri call failure is non-fatal — autocomplete just skips
      // this turn.  Surfacing the error through the popup would be
      // user-hostile.
      console.warn("[markdown] link autocomplete searchFiles failed:", err);
      return null;
    }
    if (absPaths.length === 0) return null;

    const docDir = getDocDir();
    const options: Completion[] = absPaths
      .slice(0, LINK_SUGGESTION_LIMIT)
      .map((absPath) => {
        const rel = docDir ? posixRelative(docDir, absPath) : absPath;
        const base = basename(absPath);
        // Heuristic icon hint: `.svg` files (excalidraw drawings,
        // images) get the `interface` type so CodeMirror picks a
        // distinct glyph; everything else stays as `file`.
        const type = absPath.toLowerCase().endsWith(".svg")
          ? "interface"
          : "file";
        // `detail` shows up to the right of the label in the popup
        // and is meant to *disambiguate* — when the file sits in the
        // same directory as the open doc, `rel === base` and showing
        // both renders the row as `name name`.  Drop the detail in
        // that case so the row reads cleanly.
        return {
          label: base,
          ...(rel !== base ? { detail: rel } : {}),
          // What actually gets typed when the user picks this hit.
          // Closing the paren saves them a keystroke and matches the
          // wikilink source's `name]]` apply pattern.
          apply: `${rel})`,
          type,
        };
      });

    return {
      from,
      to: ctx.pos,
      options,
      // Keep CodeMirror's incremental filter alive while the user
      // continues to type valid path characters.  `)` and `\n`
      // close the link; `]` would invalidate the trigger context.
      validFor: /^[^\n)\]]*$/,
    };
  };
}
