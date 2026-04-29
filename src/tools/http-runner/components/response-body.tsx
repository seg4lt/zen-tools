import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { Braces } from "lucide-react";
import { makeEditorTheme } from "../lib/cm-theme";
import { isJsonContentType, languageForContentType } from "../lib/parse-mime";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

interface ResponseBodyProps {
  body: string;
  contentType?: string;
}

/**
 * Read-only CodeMirror viewer for the response body.
 *
 * For JSON content-types we **auto-pretty-print** the body (2-space
 * indent) — most APIs return minified JSON which is unreadable in a
 * fixed-width editor. A toggle in the top-right flips between Pretty
 * and Raw so the user can still see the wire bytes when needed.
 * Pretty mode falls back to Raw silently if the body fails to parse
 * (e.g. error pages mis-tagged as JSON).
 */
export function ResponseBody({ body, contentType }: ResponseBodyProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { theme } = useTheme();

  const isJson = isJsonContentType(contentType);
  const [pretty, setPretty] = useState(true);

  // Compute the displayed text once per (body, contentType, pretty)
  // tuple. If pretty mode is on for a JSON body and parsing succeeds,
  // we render the indented form; otherwise the raw bytes.
  const { display, prettifiable } = useMemo(() => {
    if (!isJson || !pretty) return { display: body, prettifiable: isJson };
    try {
      const parsed = JSON.parse(body);
      return { display: JSON.stringify(parsed, null, 2), prettifiable: true };
    } catch {
      // Server lied about Content-Type or returned a fragment — fall
      // back to raw without complaining.
      return { display: body, prettifiable: false };
    }
  }, [body, isJson, pretty]);

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
      state: EditorState.create({ doc: display, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [display, contentType, theme]);

  return (
    <div className="relative h-full w-full">
      {prettifiable && (
        <div className="absolute right-1 top-1 z-10 flex items-center rounded-md border bg-card/80 backdrop-blur-sm shadow-sm">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 gap-1 rounded-none rounded-l-md px-2 text-[10px]",
              pretty
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPretty(true)}
            title="Pretty-printed JSON"
            aria-pressed={pretty}
          >
            <Braces className="size-3" />
            Pretty
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 rounded-none rounded-r-md px-2 text-[10px]",
              !pretty
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPretty(false)}
            title="Raw bytes (as received)"
            aria-pressed={!pretty}
          >
            Raw
          </Button>
        </div>
      )}
      <div ref={hostRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
