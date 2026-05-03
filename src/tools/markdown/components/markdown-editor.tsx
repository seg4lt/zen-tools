/**
 * Markdown editor — thin wrapper around the shared `CodeEditor`.
 *
 * The generic CodeMirror 6 plumbing (vim mode, `:w` / `:wq` / `:x`,
 * `Mod-S`, mount/reconfigure, theme, imperative handle) lives in
 * `@zen-tools/editor`. This file only contributes the markdown-
 * specific bits:
 *
 *   - `@codemirror/lang-markdown` with lazy-loaded code-fence parsers.
 *   - `livePreview` (image widgets, hide-markup-on-other-lines,
 *     wikilink mark + autocomplete + Mod-click).
 *   - `imagePasteHandler` — clipboard image → save next to the open
 *     `.md` → insert `![…](…)`.
 *   - `markdownHighlightStyle` layered with `Prec.high` so its
 *     markdown-tag colours win over the base `makeEditorTheme` style.
 *   - `gf` / `gd` vim normal-mode actions that follow the link under
 *     the cursor (wikilink first, fall back to a `[label](url)`).
 */

import { useEffect, useMemo, useRef, type Ref } from "react";
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Vim } from "@replit/codemirror-vim";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@zen-tools/editor";
import { useTheme } from "@/hooks/use-theme";
import { livePreview } from "../lib/live-preview";
import { imagePasteHandler } from "../lib/image-paste";
import { markdownHighlightStyle } from "../lib/markdown-highlight";

// Re-export the shared handle under the historical name so existing
// callers (`MarkdownEditorHandle`) keep working unchanged.
export type MarkdownEditorHandle = CodeEditorHandle;

export interface MarkdownEditorProps {
  /** Initial content. Used at mount only — subsequent updates come
   *  through the imperative `setValue` handle. */
  value: string;
  /** Whether the editor is read-only (e.g. while saving). */
  readOnly?: boolean;
  /** Called on every doc edit. */
  onChange?: (value: string) => void;
  /** Called when the user requests a save (`Mod-S` or `:w`). */
  onSave?: (value: string) => void;
  /** Vim toggle. Rebuilds state on change without losing content. */
  vimMode?: boolean;
  /** Returns the directory of the open `.md`. Live-preview resolves
   *  relative `![…](…)` against this; image-paste writes here. */
  getDocDir: () => string;
  /** Returns the absolute path of the open `.md`, or `null` if none. */
  getCurrentPath: () => string | null;
  /** Returns every open vault root. Used by the markdown link
   *  autocomplete (`[label](query)`) to feed fff-search across the
   *  full set of vaults the user has open. */
  getVaults: () => string[];
  /** Returns wikilink autocomplete candidates (basenames, no ext). */
  getWikilinkCandidates: () => string[];
  /** Called on `Mod+click` of a wikilink — caller resolves + opens. */
  onWikilinkOpen: (label: string) => void;
  /** Called on `Mod+click` of a regular `[label](url)` link, or when
   *  the user presses `gf` / `gd` over one in vim normal mode. */
  onLinkOpen: (url: string) => void;
  /** Fired after a clipboard image is successfully saved + linked. */
  onImageSaved?: (relPath: string) => void;
  /** `Ctrl+W h/j/k/l` — move focus between split panes. */
  onMoveFocus?: (dir: "h" | "j" | "k" | "l") => void;
  /** `Ctrl+O` — workspace-level jump back. Return `true` if handled. */
  onJumpBack?: () => boolean;
  /** `Ctrl+I` — workspace-level jump forward. */
  onJumpForward?: () => boolean;
  /** Forwarded ref for imperative control. */
  imperativeRef?: Ref<MarkdownEditorHandle>;
}

export function MarkdownEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  vimMode = true,
  getDocDir,
  getCurrentPath,
  getVaults,
  getWikilinkCandidates,
  onWikilinkOpen,
  onLinkOpen,
  onImageSaved,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  imperativeRef,
}: MarkdownEditorProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Ref to the live `EditorView` so the `gf` / `gd` action can read
  // the current cursor position. Captured via `CodeEditor`'s `onView`
  // prop on every (re-)mount.
  const viewRef = useRef<EditorView | null>(null);

  // All caller-supplied closures live behind refs so the long-lived
  // CodeMirror extensions (built once at mount, rebuilt only on
  // theme/vim/readOnly change) always see the latest props without
  // having to remount.
  const getDocDirRef = useRef(getDocDir);
  const getCurrentPathRef = useRef(getCurrentPath);
  const getVaultsRef = useRef(getVaults);
  const getCandidatesRef = useRef(getWikilinkCandidates);
  const onWikilinkOpenRef = useRef(onWikilinkOpen);
  const onLinkOpenRef = useRef(onLinkOpen);
  const onImageSavedRef = useRef(onImageSaved);
  useEffect(() => {
    getDocDirRef.current = getDocDir;
    getCurrentPathRef.current = getCurrentPath;
    getVaultsRef.current = getVaults;
    getCandidatesRef.current = getWikilinkCandidates;
    onWikilinkOpenRef.current = onWikilinkOpen;
    onLinkOpenRef.current = onLinkOpen;
    onImageSavedRef.current = onImageSaved;
  }, [
    getDocDir,
    getCurrentPath,
    getVaults,
    getWikilinkCandidates,
    onWikilinkOpen,
    onLinkOpen,
    onImageSaved,
  ]);

  // Register `gf` / `gd` once. `Vim.defineAction` is module-global so
  // it doesn't matter which markdown editor instance runs the
  // useEffect — the action reads the *currently focused* view via
  // `viewRef`, which the `onView` prop keeps fresh.
  useEffect(() => {
    const followLink = () => {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.main.head;

      // 1. Wikilink at cursor? Cheaper to test first — a simple regex
      //    over the cursor's line beats walking the lezer tree.
      const line = view.state.doc.lineAt(pos);
      const lineText = view.state.doc.sliceString(line.from, line.to);
      const cursorOffset = pos - line.from;
      const wikiRe = /\[\[([^\[\]\n]+?)\]\]/g;
      let wm: RegExpExecArray | null;
      while ((wm = wikiRe.exec(lineText)) !== null) {
        const start = wm.index;
        const end = start + wm[0].length;
        if (cursorOffset >= start && cursorOffset <= end) {
          onWikilinkOpenRef.current?.(wm[1].trim());
          return;
        }
      }

      // 2. Otherwise look for a `Link` node containing the cursor.
      let foundUrl: string | null = null;
      const tree = syntaxTree(view.state);
      tree.iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
          if (foundUrl) return false;
          if (
            node.type.name === "Link" &&
            node.from <= pos &&
            pos <= node.to
          ) {
            const cur = node.node.cursor();
            if (cur.firstChild()) {
              do {
                if (cur.type.name === "URL") {
                  foundUrl = view.state.doc
                    .sliceString(cur.from, cur.to)
                    .trim();
                  break;
                }
              } while (cur.nextSibling());
            }
            return false;
          }
        },
      });
      if (foundUrl) {
        onLinkOpenRef.current?.(foundUrl);
      }
    };

    Vim.defineAction("followLink", followLink);
    Vim.mapCommand("gf", "action", "followLink", {}, { context: "normal" });
    Vim.mapCommand("gd", "action", "followLink", {}, { context: "normal" });
  }, []);

  // The `extensions` callback is invoked on every CodeEditor rebuild
  // (theme / vim / readOnly toggles). It captures the refs above by
  // closure, so each rebuild produces a fresh `livePreview()` /
  // `imagePasteHandler()` with the right theme + latest callbacks.
  const buildExtensions = useMemo(
    () =>
      ({ isDark }: { isDark: boolean }): Extension[] => [
        // `codeLanguages` from `@codemirror/language-data` is the set
        // of every language CodeMirror ships a parser for. Each is a
        // `LanguageDescription` that *lazy-loads* its actual language
        // module on first use — so a doc with no fenced code costs
        // nothing, and a `\`\`\`ts` block triggers a one-time dynamic
        // import.
        markdown({ addKeymap: false, codeLanguages: languages }),
        livePreview({
          getDocDir: () => getDocDirRef.current(),
          getCurrentPath: () => getCurrentPathRef.current(),
          getVaults: () => getVaultsRef.current(),
          getWikilinkCandidates: () => getCandidatesRef.current(),
          onWikilinkOpen: (label) => onWikilinkOpenRef.current(label),
          onLinkOpen: (url) => onLinkOpenRef.current(url),
          getTheme: () => (isDark ? "dark" : "light"),
        }),
        imagePasteHandler({
          getCurrentPath: () => getCurrentPathRef.current(),
          onImageSaved: (rel) => onImageSavedRef.current?.(rel),
        }),
        // CodeEditor injects `makeEditorTheme()` after the caller's
        // extensions, so a plain `syntaxHighlighting(...)` here would
        // be overridden by the theme's own highlight style. Bump the
        // markdown highlight to `Prec.high` so its tag colours win
        // regardless of declaration order.
        Prec.high(syntaxHighlighting(markdownHighlightStyle)),
      ],
    [],
  );

  return (
    <CodeEditor
      value={value}
      readOnly={readOnly}
      onChange={onChange}
      onSave={onSave}
      vimMode={vimMode}
      isDark={isDark}
      imperativeRef={imperativeRef}
      extensions={buildExtensions}
      onMoveFocus={onMoveFocus}
      onJumpBack={onJumpBack}
      onJumpForward={onJumpForward}
      onView={(view) => {
        viewRef.current = view;
      }}
    />
  );
}
