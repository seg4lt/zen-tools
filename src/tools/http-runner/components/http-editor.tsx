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
import { vim, Vim } from "@replit/codemirror-vim";
import { httpLanguage } from "../lib/lang-http";
import { makeEditorTheme } from "../lib/cm-theme";
import { runGutter } from "../lib/run-gutter";
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
  /**
   * Called with the 1-based line number when the user clicks the run
   * gutter icon or presses `Mod+Enter`. The parent component is
   * responsible for mapping the line to the appropriate request.
   */
  onRunLine?: (line: number) => void;
  /** `Mod+Shift+Enter` variant — run with dependency resolution. */
  onRunLineWithDeps?: (line: number) => void;
  /**
   * Editor "mode" — drives whether we install the http language and the
   * run-gutter. `"http"` for `.http`/`.rest` files, `"plain"` for
   * `.perf.yaml` (where the gutter is meaningless).
   */
  mode?: "http" | "plain";
  /** Forwarded ref for imperative control. */
  imperativeRef?: Ref<HttpEditorHandle>;
}

/** CodeMirror 6 editor wrapper with vim + http language + theme. */
export function HttpEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  onRunLine,
  onRunLineWithDeps,
  mode = "http",
  imperativeRef,
}: HttpEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRunLineRef = useRef(onRunLine);
  const onRunLineWithDepsRef = useRef(onRunLineWithDeps);
  const { theme } = useTheme();

  // Keep latest callbacks visible to long-lived listeners.
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onRunLineRef.current = onRunLine;
    onRunLineWithDepsRef.current = onRunLineWithDeps;
  }, [onChange, onSave, onRunLine, onRunLineWithDeps]);

  // Register Vim ex commands once. `:w` / `:write` save through onSave so
  // muscle memory works inside vim mode too. The Vim wrapper passes its
  // own adapter object — we ignore it and read the live view instead.
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
    vim(),
    lineNumbers(),
    foldGutter(),
    // The run-gutter is only meaningful for `.http` files; perf YAML
    // doesn't have line-addressable runnables so we skip it.
    ...(mode === "http"
      ? [runGutter((line) => onRunLineRef.current?.(line))]
      : []),
    indentOnInput(),
    bracketMatching(),
    history(),
    highlightActiveLine(),
    ...(mode === "http" ? [httpLanguage()] : []),
    makeEditorTheme(isDark),
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
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: (view) => {
          const pos = view.state.selection.main.head;
          const lineNum = view.state.doc.lineAt(pos).number;
          onRunLineRef.current?.(lineNum);
          return true;
        },
      },
      {
        key: "Mod-Shift-Enter",
        preventDefault: true,
        run: (view) => {
          const pos = view.state.selection.main.head;
          const lineNum = view.state.doc.lineAt(pos).number;
          onRunLineWithDepsRef.current?.(lineNum);
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

  // Build the editor view exactly once per mount; theme changes are
  // reconfigured below without remounting.
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
    // We intentionally do NOT depend on `value` — content is owned by the
    // editor; setValue() through the imperative handle is the way in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-build theme + readOnly + mode when they change without remounting.
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
  }, [theme, readOnly, mode]);

  // Imperative API.
  useImperativeHandle(
    imperativeRef,
    () => ({
      setValue: (next) => {
        const view = viewRef.current;
        if (!view) return;
        if (view.state.doc.toString() === next) return;
        // Preserve the cursor position by clamping it into the new doc
        // length, so a save (which re-pushes the same content) doesn't
        // jump the user to position 0.
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
