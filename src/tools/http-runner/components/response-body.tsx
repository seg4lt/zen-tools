import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { makeEditorTheme } from "../lib/cm-theme";
import { languageForContentType } from "../lib/parse-mime";
import { useTheme } from "@/hooks/use-theme";

interface ResponseBodyProps {
  body: string;
  contentType?: string;
}

/**
 * Read-only CodeMirror viewer for the response body. JSON bodies get
 * syntax highlighting via @codemirror/lang-json.
 */
export function ResponseBody({ body, contentType }: ResponseBodyProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      bracketMatching(),
      makeEditorTheme(theme === "dark"),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      ...languageForContentType(contentType),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: body, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [body, contentType, theme]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
