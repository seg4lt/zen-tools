/**
 * Generic CodeMirror 6 wrapper shared by every tool that wants an editor.
 *
 * Owns the boilerplate that has nothing to do with a specific language:
 *
 *  - View lifecycle (mount, theme/vim/readOnly reconfigure without remount)
 *  - Vim integration + the standard Vim ex-write commands
 *  - Save (Mod-s) + run (Mod-Enter / Mod-Shift-Enter) keybindings
 *  - Imperative handle (setValue / getValue / focus / scrollToLine)
 *
 * Per-language wiring (http language, sql language, run-gutter, hover
 * tooltips) is supplied by the caller via the `extensions` prop. The
 * caller can pass a function that receives `{ isDark }` so theme-aware
 * extensions can be rebuilt when the user toggles light/dark.
 */

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
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
import { vim, Vim } from "@replit/codemirror-vim";
import { makeEditorTheme } from "@/tools/http-runner/lib/cm-theme";
import { useTheme } from "@/hooks/use-theme";

export interface CodeEditorHandle {
  /** Replace the buffer content (preserves cursor where possible). */
  setValue: (value: string) => void;
  /** Read the current buffer content. */
  getValue: () => string;
  /** Focus the editor. */
  focus: () => void;
  /** Move the cursor to a 1-based line number. */
  scrollToLine: (lineNumber: number) => void;
  /** Return the currently selected text, or `""` if no selection. */
  getSelection: () => string;
  /** Primary cursor offset into the document (0-based). */
  getCursorOffset: () => number;
}

export interface CodeEditorProps {
  /** Initial content. The editor owns the buffer after mount; updates
   * must come through `setValue` on the imperative handle. */
  value: string;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Called on every change. */
  onChange?: (value: string) => void;
  /** Called when the user requests a save (Mod-s, `:w`, `:wq`, `:x`). */
  onSave?: (value: string) => void;
  /**
   * Mod-Enter handler. Called with the 1-based line number of the
   * primary cursor.
   */
  onRunLine?: (line: number) => void;
  /** Mod-Shift-Enter variant. */
  onRunLineWithDeps?: (line: number) => void;
  /**
   * Per-tool extensions: language, run-gutter, hover tooltips, etc.
   * Passed as a function so callers can react to the theme without
   * reaching into our internals.
   */
  extensions?: (env: { isDark: boolean }) => Extension[];
  /** Vim keybindings. Default `true`. */
  vimMode?: boolean;
  /** Forwarded ref for imperative control. */
  imperativeRef?: Ref<CodeEditorHandle>;
}

/** Generic CodeMirror 6 editor. */
export function CodeEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  onRunLine,
  onRunLineWithDeps,
  extensions,
  vimMode = true,
  imperativeRef,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRunLineRef = useRef(onRunLine);
  const onRunLineWithDepsRef = useRef(onRunLineWithDeps);
  const extensionsRef = useRef(extensions);
  const { theme } = useTheme();

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onRunLineRef.current = onRunLine;
    onRunLineWithDepsRef.current = onRunLineWithDeps;
    extensionsRef.current = extensions;
  }, [onChange, onSave, onRunLine, onRunLineWithDeps, extensions]);

  // Vim ex commands — register once. The Vim wrapper passes its adapter;
  // we ignore it and read the live view.
  useEffect(() => {
    const save = () => {
      const view = viewRef.current;
      if (!view) return;
      onSaveRef.current?.(view.state.doc.toString());
    };
    Vim.defineEx("write", "w", save);
    Vim.defineEx("wq", "wq", save);
    Vim.defineEx("x", "x", save);
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
    ...(extensionsRef.current?.({ isDark }) ?? []),
    makeEditorTheme(isDark),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    // Action shortcuts at highest precedence so vim's keymap doesn't
    // swallow them in normal/insert/visual mode. Without `Prec.highest`,
    // @replit/codemirror-vim handles Mod-Enter/Mod-Shift-Enter/Mod-s
    // before our keymap fires (Enter falls through as a plain newline,
    // ⌘S triggers the browser save dialog).
    Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: (view) => {
            onSaveRef.current?.(view.state.doc.toString());
            return true;
          },
        },
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: (view) => {
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos).number;
            onRunLineRef.current?.(line);
            return true;
          },
        },
        {
          key: "Mod-Shift-Enter",
          preventDefault: true,
          run: (view) => {
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos).number;
            onRunLineWithDepsRef.current?.(line);
            return true;
          },
        },
      ]),
    ),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    }),
  ];

  // Mount.
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
    // Content is owned by the editor; mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure when theme / readOnly / vimMode flip. Doc + selection
  // ride through unchanged so toggles never lose user content.
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
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: head, head },
        });
      },
      getValue: () => viewRef.current?.state.doc.toString() ?? "",
      focus: () => viewRef.current?.focus(),
      scrollToLine: (lineNumber) => {
        const view = viewRef.current;
        if (!view) return;
        const total = view.state.doc.lines;
        const target = Math.max(1, Math.min(total, lineNumber));
        const line = view.state.doc.line(target);
        view.dispatch({
          selection: { anchor: line.from, head: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
        view.focus();
      },
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to);
      },
      getCursorOffset: () => {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.selection.main.head;
      },
    }),
    [],
  );

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
