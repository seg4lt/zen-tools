/**
 * HTML editor — Code / Preview / Split layout for `.html` / `.htm`
 * files opened in the markdown vault.
 *
 * Mirrors flowstate's `apps/flowstate/src/components/html/html-editor.tsx`.
 * After iterating with flowstate we landed on the **`<base href>` +
 * `sandbox="allow-same-origin"`** approach (instead of the original
 * empty-sandbox + recursive resource resolution):
 *
 *   - Editor pane is the shared `CodeEditor`.  Vim, Mod-S, jump-list
 *     and split focus chords come along for free.
 *   - Preview pane is `<iframe sandbox="allow-same-origin"
 *     srcDoc={withBase(source)}>`.  We inject a `<base href="asset://…">`
 *     pointing at the open file's directory before handing the markup
 *     to `srcDoc` so every relative URL — `<link rel="stylesheet">`,
 *     `<img>`, `<a href>`, `<script>`-as-resource — resolves against
 *     the file's real directory through the Tauri asset protocol.
 *   - Both panes are mounted at all times and shown/hidden via CSS so
 *     CodeMirror's `EditorView` (cursor, scroll, undo) survives every
 *     toggle.
 *
 * Why drop the empty-sandbox + resource-resolver approach we had
 * first?  The empty sandbox blocks all network, so we had to read
 * every relative resource via `markdownTauri.readFile` and inline it
 * (stylesheets) or rewrite to `asset://` (images), and we had to fully
 * pre-resolve every linked HTML page into a `data:text/html;base64,…`
 * URL just to make a click work.  `<base href>` lets the browser do
 * all that natively.
 *
 * Sandbox trade-off: `allow-same-origin` *without* `allow-scripts`
 * still prevents inline `<script>` and event-handler attributes from
 * executing — what it grants is the iframe's right to be treated as
 * same-origin with itself for resource loads under the asset protocol.
 * Adding `allow-scripts` would be a different conversation; do NOT
 * loosen the sandbox further without putting a real sanitiser
 * (DOMPurify) in front of the source first.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Code as CodeIcon, Eye, Columns2, RefreshCw } from "lucide-react";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@zen-tools/editor";
import { Button, cn } from "@zen-tools/ui";
import { useTheme } from "@/hooks/use-theme";
import { assetUrl } from "../lib/tauri";

// Re-export the shared editor handle under the historical naming so a
// future caller can swap one editor for another behind the same ref.
export type HtmlEditorHandle = CodeEditorHandle;

export interface HtmlEditorProps {
  /** Initial document — the editor owns the buffer after mount. */
  value: string;
  /** Whether the editor is read-only. */
  readOnly?: boolean;
  /** Called on every doc edit. */
  onChange?: (value: string) => void;
  /** Called when the user requests a save (`Mod-S` / `:w`). */
  onSave?: (value: string) => void;
  /** Vim toggle. */
  vimMode?: boolean;
  /** Returns the directory of the open `.html` so we can build a
   *  `<base href>` against it for relative-URL resolution. */
  getDocDir: () => string;
  /** `Ctrl+W h/j/k/l` — move focus between split panes. */
  onMoveFocus?: (dir: "h" | "j" | "k" | "l") => void;
  /** `Ctrl+O` — workspace-level jump back. Return `true` if handled. */
  onJumpBack?: () => boolean;
  /** `Ctrl+I` — workspace-level jump forward. */
  onJumpForward?: () => boolean;
  /** Forwarded ref for imperative control of the editor pane. */
  imperativeRef?: Ref<HtmlEditorHandle>;
}

/** Tri-state layout for the Code / Preview panes. */
type ViewMode = "code" | "preview" | "split";

/**
 * Inject a `<base href="asset://…/">` pointing at the open document's
 * directory.  Behaviour is best-effort and never throws:
 *
 *   - Empty doc  → return as-is (the iframe shows a blank frame).
 *   - Already has a `<base>` → leave the author's tag alone.  They
 *     made an explicit choice; honour it.
 *   - Has `<head>` but no `<base>` → prepend a `<base>` inside `<head>`.
 *   - No `<head>` (e.g. user pasted a fragment) → wrap the document
 *     in a synthetic skeleton so the base actually lands somewhere
 *     the browser respects.
 *
 * We use `DOMParser` rather than the cheap `<head[^>]*>` regex
 * replacement so an existing `<base>` doesn't get a sibling that
 * would shadow it — the *first* `<base>` in document order wins, and
 * a regex prepend would silently override the author's choice.
 */
function withBase(html: string, docDir: string): string {
  if (!html.trim()) return "";
  if (!docDir) return html;
  // `convertFileSrc()` (the engine behind `assetUrl`) calls
  // `encodeURIComponent` on the *entire* path — including the
  // separators — so `/Users/x/dir/` becomes
  // `asset://localhost/%2FUsers%2Fx%2Fdir%2F`. That URL has no
  // literal trailing `/`, which means the browser treats the whole
  // encoded blob as the "filename" segment of the base — so
  // `./style.css` resolves to `asset://localhost/style.css`,
  // wiping the directory entirely. The fix: strip any trailing
  // slash before converting, then append a *literal* `/` after.
  // The asset-protocol handler decodes the `%2F` segments back into
  // real slashes when serving the request, so the on-disk path is
  // resolved correctly.
  const dirAbs = docDir.replace(/\/+$/, "");
  const baseHref = `${assetUrl(dirAbs)}/`;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch (err) {
    console.warn("[html-editor] DOMParser failed; serving raw markup", err);
    return html;
  }

  // Author already declared a base — defer to them.  Their `<base>`
  // is *the* base for the doc per HTML spec, so adding ours wouldn't
  // do anything anyway, but skipping the work makes the intent obvious.
  if (doc.querySelector("base")) {
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  }

  let head = doc.head;
  if (!head) {
    // Fragment input — give it a real document scaffold so `<base>`
    // attaches inside a `<head>` the browser will actually consult.
    head = doc.createElement("head");
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
  }

  const base = doc.createElement("base");
  base.setAttribute("href", baseHref);
  // Prepend so a later `<meta charset>` or stylesheet that references
  // a relative URL sees the base set first.  The HTML parser would do
  // the same on a normal load.
  head.insertBefore(base, head.firstChild);

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/**
 * Three render shapes — `code` only, `preview` only, or a 50/50
 * vertical split.  The CodeEditor instance is mounted once and reused
 * across mode changes (we just hide it with `display: none` in
 * `preview` mode) so cursor / scroll / undo history all survive
 * toggles.
 */
export function HtmlEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  vimMode = true,
  getDocDir,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  imperativeRef,
}: HtmlEditorProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [mode, setMode] = useState<ViewMode>("split");

  // Live source — kept in React state so the iframe's `srcDoc` updates
  // as the user types.  Seeded from the initial `value`; subsequent
  // changes flow through the editor's `onChange`.
  const [source, setSource] = useState(value);

  // Document dir is read on every render so a tab switch (which
  // changes the parent's `getDocDir` closure) immediately reflects in
  // the next preview pass.  Cheap — it's a pure string lookup on the
  // active tab's path.
  const docDir = getDocDir();

  // Force-render token so the user can re-run `withBase` (and the
  // implicit asset reload that comes with a fresh `srcDoc`) even when
  // `source` and `docDir` are unchanged — useful after editing a
  // referenced stylesheet outside this view.
  const [refreshTick, setRefreshTick] = useState(0);

  const handleChange = useCallback(
    (next: string) => {
      setSource(next);
      onChange?.(next);
    },
    [onChange],
  );

  // Reset local source whenever the parent hands us a fresh `value` —
  // happens on tab switch.  The editor's own `setValue` is driven by
  // the parent through the imperative ref; this just keeps our
  // preview state in sync with that.
  useEffect(() => {
    setSource(value);
  }, [value]);

  // Skip the parse/serialize round-trip while the preview is hidden.
  // `lastRendered` carries the most recent computed frame so flipping
  // back to preview shows it instantly without a render hiccup.
  const lastRenderedRef = useRef<string>("");
  const rendered = useMemo(() => {
    if (mode === "code") return lastRenderedRef.current;
    const html = withBase(source, docDir);
    lastRenderedRef.current = html;
    return html;
    // refreshTick is a deliberate trigger — re-running `withBase`
    // forces React to hand the iframe a "new" srcDoc string even when
    // source/docDir didn't change, which makes the iframe drop and
    // re-fetch every asset:// resource it links to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, docDir, mode, refreshTick]);

  const onRefresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b bg-card/50 px-2">
        <ModeButton
          mode={mode}
          target="code"
          onSelect={setMode}
          icon={<CodeIcon className="size-3" />}
          label="Code"
        />
        <ModeButton
          mode={mode}
          target="split"
          onSelect={setMode}
          icon={<Columns2 className="size-3" />}
          label="Split"
        />
        <ModeButton
          mode={mode}
          target="preview"
          onSelect={setMode}
          icon={<Eye className="size-3" />}
          label="Preview"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            title="Re-render preview"
            onClick={onRefresh}
            className="gap-1"
            disabled={mode === "code"}
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            mode === "preview" && "hidden",
            mode === "split" ? "flex-1 border-r" : "flex-1",
          )}
        >
          <CodeEditor
            imperativeRef={imperativeRef}
            value={value}
            readOnly={readOnly}
            onChange={handleChange}
            onSave={onSave}
            onMoveFocus={onMoveFocus}
            onJumpBack={onJumpBack}
            onJumpForward={onJumpForward}
            vimMode={vimMode}
            isDark={isDark}
          />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 bg-white",
            mode === "code" && "hidden",
            mode === "split" ? "flex-1" : "flex-1",
          )}
        >
          <iframe
            // `allow-same-origin` *without* `allow-scripts` lets the
            // iframe load asset:// resources (stylesheets, images,
            // anchors) but still blocks inline JS and event-handler
            // attributes.  Don't add `allow-scripts` without putting
            // DOMPurify in front of `source` first — that would let
            // user-authored markup run JS in the host webview.
            sandbox="allow-same-origin"
            srcDoc={rendered}
            title="HTML preview"
            className="h-full w-full border-0 bg-white"
          />
        </div>
      </div>
    </div>
  );
}

interface ModeButtonProps {
  mode: ViewMode;
  target: ViewMode;
  onSelect: (mode: ViewMode) => void;
  icon: React.ReactNode;
  label: string;
}

function ModeButton({ mode, target, onSelect, icon, label }: ModeButtonProps) {
  const active = mode === target;
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => onSelect(target)}
      className={cn(
        "gap-1 px-2",
        active && "bg-accent text-accent-foreground",
      )}
      title={label}
    >
      {icon}
      <span className="text-[11px]">{label}</span>
    </Button>
  );
}
