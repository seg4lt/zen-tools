/**
 * CodeMirror 6 editor for `.http` files.
 *
 * Vanilla CM6 (no `@uiw/react-codemirror`) so we keep full control over
 * extensions: vim mode, the custom http language, save-on-Mod-s, and the
 * run-gutter (added in the next phase).
 */

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
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
import { vim } from "@replit/codemirror-vim";
import { httpLanguage } from "../lib/lang-http";
import { makeEditorTheme } from "../lib/cm-theme";
import { useTheme } from "@/hooks/use-theme";

export interface HttpEditorHandle {
  /** Replace the buffer content. */
  setValue: (value: string) => void;
  /** Read the current buffer content. */
  getValue: () => string;
  /** Focus the editor. */
  focus: () => void;
  /** Move the cursor to a 1-based line number. */
  scrollToLine: (lineNumber: number) => void;
}

export interface HttpEditorProps {
  /** Initial content. */
  value: string;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Called on every change. */
  onChange?: (value: string) => void;
  /** Called when the user requests a save (Mod-s). */
  onSave?: (value: string) => void;
  /** Forwarded ref for imperative control. */
  imperativeRef?: Ref<HttpEditorHandle>;
}

/** CodeMirror 6 editor wrapper with vim + http language + theme. */
export function HttpEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  imperativeRef,
}: HttpEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const { theme } = useTheme();

  // Keep latest callbacks visible to long-lived listeners.
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  }, [onChange, onSave]);

  // Build the editor view exactly once per mount; theme changes are
  // reconfigured below without remounting.
  useEffect(() => {
    if (!hostRef.current) return;

    const extensions: Extension[] = [
      vim(),
      lineNumbers(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      history(),
      highlightActiveLine(),
      httpLanguage(),
      makeEditorTheme(theme === "dark"),
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

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally do NOT depend on `value` — content is owned by the
    // editor; setValue() through the imperative handle is the way in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-build theme + readOnly when they change without remounting.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [],
    });
    // Reconfigure by replacing the EditorState with a fresh one preserving
    // the doc + selection.
    const doc = view.state.doc;
    const selection = view.state.selection;
    const extensions: Extension[] = [
      vim(),
      lineNumbers(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      history(),
      highlightActiveLine(),
      httpLanguage(),
      makeEditorTheme(theme === "dark"),
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
          run: (v) => {
            onSaveRef.current?.(v.state.doc.toString());
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
    view.setState(EditorState.create({ doc, selection, extensions }));
  }, [theme, readOnly]);

  // Imperative API.
  useImperativeHandle(
    imperativeRef,
    () => ({
      setValue: (next) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: next,
          },
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
    }),
    [],
  );

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
