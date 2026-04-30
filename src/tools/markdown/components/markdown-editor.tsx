/**
 * CodeMirror 6 host for `.md` editing.
 *
 * Modeled directly on `http-runner/components/http-editor.tsx` — same
 * mount-once + reconfigure-on-prop-change pattern, same vim ex-command
 * registration (`:w`, `:wq`, `:x`), same `Mod-S` keymap.
 *
 * Differences:
 *   - Language extension is `@codemirror/lang-markdown` instead of the
 *     custom http one.
 *   - Live-preview extension array (image widgets, hide-markup-on-
 *     other-lines, wikilink mark + autocomplete + Mod-click).
 *   - Image-paste handler — clipboard image → save next to the open
 *     `.md` → insert `![…](…)`.
 *
 * The editor doesn't read the store directly; instead the parent
 * passes value-getters via callbacks so this component never needs to
 * remount when the open file changes.
 */

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { vim, Vim } from "@replit/codemirror-vim";
import { makeEditorTheme } from "@/tools/http-runner/lib/cm-theme";
import { useTheme } from "@/hooks/use-theme";
import { livePreview } from "../lib/live-preview";
import { imagePasteHandler } from "../lib/image-paste";
import { markdownHighlightStyle } from "../lib/markdown-highlight";

export interface MarkdownEditorHandle {
  setValue: (value: string) => void;
  getValue: () => string;
  focus: () => void;
  /** Scroll the viewport so 1-based `lineNumber` is centred and place
   *  the cursor at its start.  No-op when the editor isn't ready. */
  scrollToLine: (lineNumber: number) => void;
}

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
  /** Vim toggle.  Rebuilds state on change without losing content. */
  vimMode?: boolean;
  /** Returns the directory of the open `.md`.  Live-preview resolves
   *  relative `![…](…)` against this; image-paste writes here. */
  getDocDir: () => string;
  /** Returns the absolute path of the open `.md`, or `null` if none. */
  getCurrentPath: () => string | null;
  /** Returns wikilink autocomplete candidates (basenames, no ext). */
  getWikilinkCandidates: () => string[];
  /** Called on `Mod+click` of a wikilink — caller resolves + opens. */
  onWikilinkOpen: (label: string) => void;
  /** Called on `Mod+click` of a regular `[label](url)` link, or when
   *  the user presses `gf` / `gd` over one in vim normal mode. */
  onLinkOpen: (url: string) => void;
  /** Fired after a clipboard image is successfully saved + linked. */
  onImageSaved?: (relPath: string) => void;
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
  getWikilinkCandidates,
  onWikilinkOpen,
  onLinkOpen,
  onImageSaved,
  imperativeRef,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const getDocDirRef = useRef(getDocDir);
  const getCurrentPathRef = useRef(getCurrentPath);
  const getCandidatesRef = useRef(getWikilinkCandidates);
  const onWikilinkOpenRef = useRef(onWikilinkOpen);
  const onLinkOpenRef = useRef(onLinkOpen);
  const onImageSavedRef = useRef(onImageSaved);
  const { theme } = useTheme();

  // Keep refs current so long-lived listeners always see the latest
  // closures.  We rebuild the editor when `vimMode` / `theme` /
  // `readOnly` change but *not* on every render — these refs let
  // callers swap callbacks on the fly.
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    getDocDirRef.current = getDocDir;
    getCurrentPathRef.current = getCurrentPath;
    getCandidatesRef.current = getWikilinkCandidates;
    onWikilinkOpenRef.current = onWikilinkOpen;
    onLinkOpenRef.current = onLinkOpen;
    onImageSavedRef.current = onImageSaved;
  }, [
    onChange,
    onSave,
    getDocDir,
    getCurrentPath,
    getWikilinkCandidates,
    onWikilinkOpen,
    onLinkOpen,
    onImageSaved,
  ]);

  // Vim ex commands — register once.  `:w` / `:wq` / `:x` save through
  // `onSave` so muscle memory works inside vim mode.  `gf` / `gd`
  // follow whatever link the cursor is sitting on (wikilink first,
  // fall back to a standard `[label](url)` link).
  useEffect(() => {
    const save = () => {
      const view = viewRef.current;
      if (!view) return;
      onSaveRef.current?.(view.state.doc.toString());
    };
    Vim.defineEx("write", "w", save);
    Vim.defineEx("wq", "wq", save);
    Vim.defineEx("x", "x", save);

    const followLink = () => {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.main.head;

      // 1. Wikilink at cursor?  Cheaper to test first — a simple
      //    regex over the cursor's line beats walking the lezer tree.
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

  const buildExtensions = (isDark: boolean): Extension[] => [
    ...(vimMode ? [vim()] : []),
    lineNumbers(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    history(),
    highlightActiveLine(),
    // `codeLanguages` from `@codemirror/language-data` is the set of
    // every language CodeMirror ships a parser for.  Each is a
    // `LanguageDescription` that *lazy-loads* its actual language
    // module on first use — so a doc with no fenced code costs
    // nothing, and a `\`\`\`ts` block triggers a one-time dynamic
    // import.  Markdown's own parser tags the tokens, then our
    // `cm-theme` `HighlightStyle` colours them.
    markdown({ addKeymap: false, codeLanguages: languages }),
    livePreview({
      getDocDir: () => getDocDirRef.current(),
      getWikilinkCandidates: () => getCandidatesRef.current(),
      onWikilinkOpen: (label) => onWikilinkOpenRef.current(label),
      onLinkOpen: (url) => onLinkOpenRef.current(url),
    }),
    imagePasteHandler({
      getCurrentPath: () => getCurrentPathRef.current(),
      onImageSaved: (rel) => onImageSavedRef.current?.(rel),
    }),
    makeEditorTheme(isDark),
    // Layered after `makeEditorTheme` so its `syntaxHighlighting` is
    // already in scope; the markdown-specific rules win on tag
    // conflicts (multiple `syntaxHighlighting` extensions stack and
    // the *last* one declared takes priority).
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
      {
        key: "Mod-s",
        preventDefault: true,
        run: (view) => {
          onSaveRef.current?.(view.state.doc.toString());
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    }),
  ];

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(theme === "dark"),
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure on theme / readOnly / vimMode without remounting.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const selection = view.state.selection;
    view.setState(
      EditorState.create({
        doc,
        selection,
        extensions: buildExtensions(theme === "dark"),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, readOnly, vimMode]);

  useImperativeHandle(
    imperativeRef,
    () => ({
      setValue: (next) => {
        const view = viewRef.current;
        if (!view) return;
        if (view.state.doc.toString() === next) return;
        const head = Math.min(view.state.selection.main.head, next.length);
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: next,
          },
          selection: { anchor: head, head },
        });
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? "",
      focus: () => viewRef.current?.focus(),
      scrollToLine: (lineNumber: number) => {
        const view = viewRef.current;
        if (!view) return;
        const total = view.state.doc.lines;
        if (total === 0) return;
        const clamped = Math.max(1, Math.min(lineNumber, total));
        const line = view.state.doc.line(clamped);
        view.dispatch({
          selection: { anchor: line.from, head: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
      },
    }),
    [],
  );

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 w-full overflow-hidden bg-background"
    />
  );
}
