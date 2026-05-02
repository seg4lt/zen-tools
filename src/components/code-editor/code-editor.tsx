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
   * Alt-Enter (Option+Enter on macOS) handler. Receives the underlying
   * `EditorView` so the caller can read cursor coordinates / dispatch
   * effects (e.g. open an actions popup at the caret). Fires at
   * `Prec.highest` alongside the other action shortcuts so vim mode
   * and `defaultKeymap`'s `splitLine` don't shadow it.
   */
  onAltEnter?: (view: EditorView) => void;
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
  /**
   * Optional callback fired when the underlying `EditorView` is
   * (re)created or destroyed. Lets a caller drive cursor-coordinate
   * reads (`coordsAtPos`) and `view.dispatch` from React without
   * forking the editor or threading every operation through the
   * imperative handle.
   */
  onView?: (view: EditorView | null) => void;
}

/** Generic CodeMirror 6 editor. */
export function CodeEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  onRunLine,
  onRunLineWithDeps,
  onAltEnter,
  extensions,
  vimMode = true,
  imperativeRef,
  onView,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRunLineRef = useRef(onRunLine);
  const onRunLineWithDepsRef = useRef(onRunLineWithDeps);
  const onAltEnterRef = useRef(onAltEnter);
  const extensionsRef = useRef(extensions);
  const onViewRef = useRef(onView);
  const { theme } = useTheme();

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onRunLineRef.current = onRunLine;
    onRunLineWithDepsRef.current = onRunLineWithDeps;
    onAltEnterRef.current = onAltEnter;
    extensionsRef.current = extensions;
    onViewRef.current = onView;
  }, [
    onChange,
    onSave,
    onRunLine,
    onRunLineWithDeps,
    onAltEnter,
    extensions,
    onView,
  ]);

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
        {
          // Option+Enter (mac) / Alt+Enter — opens the per-tool
          // actions popup. At `Prec.highest` so neither vim mode's
          // keymap nor `defaultKeymap`'s `splitLine` shadows it. The
          // handler is a no-op when no callback is wired.
          key: "Alt-Enter",
          preventDefault: true,
          run: (view) => {
            if (!onAltEnterRef.current) return false;
            onAltEnterRef.current(view);
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
    // Vim-mode click defence.
    //
    // `@replit/codemirror-vim` has a long-standing quirk: after the
    // user scrolls the editor (mouse-wheel or scrollbar) and *then*
    // clicks somewhere visible, vim sometimes produces a phantom
    // selection running from the stale pre-scroll cursor anchor to
    // the click point. The click coordinates are hit-tested against
    // the new viewport, but vim's internal anchor is still pinned
    // to the old offset, so CM ends up creating a range instead of
    // a single-cursor placement.
    //
    // Workaround: track every plain left-button mousedown (no
    // modifier keys, no movement during the press) and, once the
    // matching mouseup fires, collapse any selection wider than 1
    // char back to a single cursor at the click head. We tolerate
    // the 1-char-wide case so vim's normal-mode block-cursor
    // rendering still works on implementations that store it as a
    // 1-char selection.
    //
    // - Modified clicks (Shift / ⌘ / Ctrl / Alt) bypass entirely so
    //   shift-click range-extension and ⌘-click multi-cursor still
    //   work as expected.
    // - Click-and-drag (mouse moves >3 px between down and up) also
    //   bypasses, so the user can still drag-select normally.
    ...(vimMode
      ? [
          EditorView.domEventHandlers({
            mousedown(event) {
              if (
                event.button !== 0 ||
                event.shiftKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              ) {
                return false;
              }
              const sx = event.clientX;
              const sy = event.clientY;
              let moved = false;
              const onMove = (e: MouseEvent) => {
                if (
                  Math.abs(e.clientX - sx) > 3 ||
                  Math.abs(e.clientY - sy) > 3
                ) {
                  moved = true;
                }
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                if (moved) return;
                // Defer past CM's own click handler so we collapse
                // *after* it has computed and applied its selection.
                queueMicrotask(() => {
                  const v = viewRef.current;
                  if (!v) return;
                  const sel = v.state.selection.main;
                  if (sel.to - sel.from > 1) {
                    v.dispatch({
                      selection: { anchor: sel.head, head: sel.head },
                    });
                  }
                });
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
              return false;
            },
          }),
        ]
      : []),
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
    onViewRef.current?.(view);
    return () => {
      onViewRef.current?.(null);
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
