/**
 * Unified search palette — port of Flowstate's fff search.
 *
 *   - `Cmd+P`        opens in **Files** mode.  Fuzzy-or-substring
 *                    rank over every `.md` in every open vault.
 *   - `Cmd+Shift+F`  opens in **Content** mode.  Backend grep across
 *                    the same files, with regex / case-sensitive /
 *                    include / exclude options.
 *   - The header `[Files | Content]` toggle swaps modes without
 *                    closing the palette; the same shortcut presses
 *                    while open also toggle.
 *   - `↑ / ↓` move the highlight, `Enter` opens the highlighted hit,
 *     `Esc` closes (handled by the underlying Radix dialog).
 *
 * File-name ranking is pure-frontend (`lib/file-rank.ts`).  Content
 * search hits the backend `markdown_search_contents` Tauri command
 * with a 600 ms debounce + cancellation token — same cadence as
 * Flowstate.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  CaseSensitive,
  FileText,
  Filter,
  Loader2,
  Regex,
  Sparkles,
  TextSearch,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  basenameNoExt,
  markdownTauri,
  type ContentBlock,
  type ContentSearchOptions,
} from "../lib/tauri";
import { PICKER_RESULT_LIMIT } from "../lib/file-rank";
import {
  activeTab,
  useMarkdownStore,
  type SearchMode,
} from "../store/markdown-store";
import { useOpenFile } from "../hooks/use-open-file";

/** Match Flowstate's debounce so type-and-wait feels identical. */
const CONTENT_SEARCH_DEBOUNCE_MS = 600;

/** File search debounces faster — fff-search returns from a warm
 *  in-memory index in single-digit ms, so the only reason to wait
 *  at all is to coalesce bursty keystrokes. */
const FILE_SEARCH_DEBOUNCE_MS = 80;

/** Flat result row used by the keyboard-nav code below. */
type FlatResult =
  | { kind: "file"; path: string; key: string }
  | {
      kind: "content";
      path: string;
      line: number;
      /** First line of the match block — used as the row's preview text. */
      text: string;
      key: string;
    };

export function SearchPalette() {
  const { state, dispatch } = useMarkdownStore();
  const { openFile } = useOpenFile();

  const open = state.searchOpen;
  const mode = state.searchMode;

  // Live query lives in local state — flushing every keystroke into
  // the global store would force every consumer to re-render.
  const [query, setQuery] = useState("");
  const [useFuzzy, setUseFuzzy] = useState(false); // file-mode toggle
  const [useRegex, setUseRegex] = useState(false); // content toggle
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [useFuzzyContent, setUseFuzzyContent] = useState(false);
  const [includes, setIncludes] = useState("");
  const [excludes, setExcludes] = useState("");
  const [contentBlocks, setContentBlocks] = useState<ContentBlock[]>([]);
  const [searching, setSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const tokenRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // On open: reset query + grab focus.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlightIdx(0);
    setContentBlocks([]);
    setErrorMsg(null);
    // Defer one frame so the dialog is fully mounted.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, mode]);

  // Flat list of `.md` paths across every vault — re-derived only
  // when the discovered files change, not on every keystroke.
  const allMarkdownPaths = useMemo(() => {
    const out: string[] = [];
    for (const vault of Object.values(state.files)) {
      for (const item of vault.items) {
        if (!item.isDir && item.kind === "markdown") out.push(item.path);
      }
    }
    return out;
  }, [state.files]);

  // ── File-mode results ──────────────────────────────────────────
  //
  // Empty query: surface recents first, then everything else
  // (synchronous, client-side — no point hitting fff-search just to
  // get the file list back unranked).
  //
  // Non-empty query: debounced Tauri call into
  // `markdown_search_files`, which delegates to fff-search's
  // `FilePicker::fuzzy_search`.  Backend ranking is more accurate
  // than the pure-TS subsequence scorer we used to ship and uses
  // the same warm in-memory index that backs grep.  We post-filter
  // the ranked result against `allMarkdownPaths` so non-`.md`
  // hits (images, drawings, configs that happen to live in the
  // vault) don't surface in the palette — keeps today's UX while
  // letting the engine see every file for ranking purposes.
  const tabPath = activeTab(state)?.path ?? null;
  const [fileResults, setFileResults] = useState<string[]>([]);
  const fileSearchAbortRef = useRef(0);
  useEffect(() => {
    if (mode !== "files") return;
    const trimmed = query.trim();
    if (!trimmed) {
      const recentSet = new Set(state.recents);
      const recentsHere = state.recents.filter((p) =>
        recentSet.has(p) ? allMarkdownPaths.includes(p) : false,
      );
      const rest = allMarkdownPaths.filter((p) => !recentSet.has(p));
      setFileResults(
        [...recentsHere, ...rest].slice(0, PICKER_RESULT_LIMIT),
      );
      return;
    }
    // Bump an abort counter so a slower in-flight call's result
    // can't clobber a newer one when the user types fast.
    const myToken = ++fileSearchAbortRef.current;
    const timer = window.setTimeout(() => {
      void markdownTauri
        .searchFiles(state.vaults, trimmed, tabPath)
        .then((results) => {
          if (myToken !== fileSearchAbortRef.current) return;
          const mdSet = new Set(allMarkdownPaths);
          setFileResults(
            results
              .filter((p) => mdSet.has(p))
              .slice(0, PICKER_RESULT_LIMIT),
          );
        })
        .catch((err) => {
          if (myToken !== fileSearchAbortRef.current) return;
          console.warn("[markdown] searchFiles failed:", err);
          setFileResults([]);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `useFuzzy` intentionally omitted — fff-search's fuzzy_search
    // is always Smith-Waterman; the toggle remains meaningful for
    // content mode only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    query,
    state.vaults,
    state.recents,
    allMarkdownPaths,
    tabPath,
  ]);

  // ── Content-mode debounced search ──────────────────────────────
  useEffect(() => {
    if (!open || mode !== "content") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setContentBlocks([]);
      setErrorMsg(null);
      setSearching(false);
      return;
    }
    // Cancel any in-flight search before scheduling a new one.
    if (tokenRef.current !== 0) {
      void markdownTauri.stopContentSearch(tokenRef.current);
    }
    const timer = window.setTimeout(async () => {
      const myToken = Date.now();
      tokenRef.current = myToken;
      setSearching(true);
      setErrorMsg(null);
      try {
        const opts: ContentSearchOptions = {
          useRegex: useFuzzyContent ? false : useRegex,
          caseSensitive: useFuzzyContent ? false : caseSensitive,
          useFuzzy: useFuzzyContent,
          includes: splitGlobs(includes),
          excludes: splitGlobs(excludes),
        };
        const blocks = await markdownTauri.searchContents(
          state.vaults,
          trimmed,
          opts,
          myToken,
        );
        // Late return — a newer search has started; drop the result.
        if (tokenRef.current !== myToken) return;
        setContentBlocks(blocks);
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        setErrorMsg(msg);
        setContentBlocks([]);
      } finally {
        if (tokenRef.current === Date.now() || true) {
          setSearching(false);
        }
      }
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    open,
    mode,
    query,
    useRegex,
    caseSensitive,
    useFuzzyContent,
    includes,
    excludes,
    state.vaults,
  ]);

  // Cancel any pending search on unmount / palette close.
  useEffect(() => {
    if (open) return;
    if (tokenRef.current !== 0) {
      void markdownTauri.stopContentSearch(tokenRef.current);
      tokenRef.current = 0;
    }
  }, [open]);

  // ── Flatten results so ↑/↓/Enter operates on a single index ────
  const flat: FlatResult[] = useMemo(() => {
    if (mode === "files") {
      return fileResults.map((p) => ({ kind: "file", path: p, key: p }));
    }
    const out: FlatResult[] = [];
    for (const block of contentBlocks) {
      // Emit one row per match line.  Surrounding context lives in
      // the right-hand preview pane, lazy-read from disk, so we only
      // need the match line's text here for the compact left row.
      for (const ln of block.lines) {
        if (!ln.isMatch) continue;
        out.push({
          kind: "content",
          path: block.path,
          line: ln.line,
          text: ln.text,
          key: `${block.path}:${ln.line}`,
        });
      }
    }
    return out;
  }, [mode, fileResults, contentBlocks]);

  // Reset highlight when the result set changes.
  useEffect(() => {
    setHighlightIdx(0);
  }, [flat]);

  // Scroll the highlighted row into view as the user navigates.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${highlightIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const close = useCallback(() => {
    dispatch({ type: "setSearchPalette", open: false });
  }, [dispatch]);

  const setMode = useCallback(
    (next: SearchMode) => {
      dispatch({ type: "setSearchMode", mode: next });
    },
    [dispatch],
  );

  const commit = useCallback(
    (idx: number) => {
      const item = flat[idx];
      if (!item) return;
      // Content-row hits carry a 1-based line; openFile threads it
      // through to the editor's scrollToLine after the tab loads.
      const gotoLine = item.kind === "content" ? item.line : undefined;
      void openFile(item.path, gotoLine);
      close();
    },
    [flat, openFile, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((idx) => Math.min(idx + 1, Math.max(0, flat.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((idx) => Math.max(idx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(highlightIdx);
    } else if (e.key === "Tab") {
      // Tab inside the input toggles mode — Flowstate ergonomics.
      e.preventDefault();
      setMode(mode === "files" ? "content" : "files");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        // Pin the cap via inline style + `overflow-hidden` so the
        // grid container DialogContent uses can't auto-expand to fit
        // a runaway-long URL inside one of the rows.
        style={{ maxWidth: "64rem" }}
        className="w-full gap-0 overflow-hidden p-0"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // Let our own focus-on-mount effect run first.
          e.preventDefault();
        }}
      >
        {/* Mode tabs */}
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <ModeTab
            label="Files"
            icon={FileText}
            shortcut="⌘P"
            active={mode === "files"}
            onClick={() => setMode("files")}
          />
          <ModeTab
            label="Content"
            icon={TextSearch}
            shortcut="⌘⇧F"
            active={mode === "content"}
            onClick={() => setMode("content")}
          />
          <span className="ml-auto text-[10px] text-muted-foreground/60">
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">
              Tab
            </kbd>{" "}
            to switch ·{" "}
            <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">
              Esc
            </kbd>{" "}
            to close
          </span>
        </div>

        {/* Query + per-mode option toggles */}
        <div className="flex items-center gap-1 border-b px-2 py-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === "files"
                ? "Type to filter files…"
                : "Type to grep across vaults…"
            }
            className="flex-1 bg-transparent px-1 py-1 text-sm outline-none"
          />
          {mode === "files" ? (
            <OptionToggle
              icon={Sparkles}
              label="Fuzzy"
              active={useFuzzy}
              onToggle={() => setUseFuzzy((v) => !v)}
            />
          ) : (
            <>
              <OptionToggle
                icon={Sparkles}
                label="Fuzzy (all-words)"
                active={useFuzzyContent}
                onToggle={() => setUseFuzzyContent((v) => !v)}
              />
              <OptionToggle
                icon={Regex}
                label="Regex"
                active={useRegex}
                onToggle={() => setUseRegex((v) => !v)}
                disabled={useFuzzyContent}
              />
              <OptionToggle
                icon={CaseSensitive}
                label="Case"
                active={caseSensitive}
                onToggle={() => setCaseSensitive((v) => !v)}
                disabled={useFuzzyContent}
              />
              <OptionToggle
                icon={Filter}
                label="Filters"
                active={showAdvanced}
                onToggle={() => setShowAdvanced((v) => !v)}
              />
            </>
          )}
        </div>

        {/* Advanced glob row (content mode only) */}
        {mode === "content" && showAdvanced ? (
          <div className="flex flex-col gap-1 border-b px-2 py-1.5 text-xs">
            <GlobInput
              label="Include"
              placeholder="docs/**, **/*.md (comma-separated)"
              value={includes}
              onChange={(v) => setIncludes(v)}
            />
            <GlobInput
              label="Exclude"
              placeholder="archive/**, **/draft-*.md"
              value={excludes}
              onChange={(v) => setExcludes(v)}
            />
          </div>
        ) : null}

        {/* Split: results list (left) + lazy file preview (right).
            `min-w-0` on the flex container lets the grid item it's
            nested under (DialogContent's `display: grid`) shrink
            against the dialog's max-width — without it, a long row
            of match text would expand the grid column and push the
            whole dialog wider than `max-w-5xl`. */}
        <div className="flex h-[min(60vh,520px)] min-h-[320px] min-w-0 overflow-hidden">
          <div
            ref={listRef}
            className="w-2/5 max-w-[420px] shrink-0 overflow-x-hidden overflow-y-auto border-r p-1"
          >
            {mode === "content" && searching ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Searching…
              </div>
            ) : null}
            {errorMsg ? (
              <div className="px-3 py-2 text-xs text-destructive">
                {errorMsg}
              </div>
            ) : null}
            {flat.length === 0 && !searching && !errorMsg ? (
              <div className="px-3 py-2 text-xs text-muted-foreground/60">
                {mode === "files" && query.trim()
                  ? "No matching files."
                  : mode === "content" && query.trim()
                    ? "No matches."
                    : mode === "files"
                      ? "Type to filter files."
                      : "Type to grep across vaults."}
              </div>
            ) : null}
            {flat.map((item, idx) => (
              <ResultRow
                key={item.key}
                item={item}
                idx={idx}
                active={idx === highlightIdx}
                vaults={state.vaults}
                onHover={() => setHighlightIdx(idx)}
                onClick={() => commit(idx)}
              />
            ))}
          </div>
          <PreviewPane
            selected={flat[highlightIdx] ?? null}
            vaults={state.vaults}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ModeTabProps {
  label: string;
  icon: typeof FileText;
  shortcut: string;
  active: boolean;
  onClick: () => void;
}

function ModeTab({ label, icon: Icon, shortcut, active, onClick }: ModeTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        active
          ? "bg-primary/15 font-semibold text-primary"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      <span className="text-[10px] text-muted-foreground/60">{shortcut}</span>
    </button>
  );
}

interface OptionToggleProps {
  icon: typeof Sparkles;
  label: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

function OptionToggle({
  icon: Icon,
  label,
  active,
  onToggle,
  disabled,
}: OptionToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        disabled
          ? `${label}: disabled in fuzzy mode`
          : `${label}: ${active ? "on" : "off"}`
      }
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded transition-colors",
        active && !disabled
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

interface GlobInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}

function GlobInput({ label, placeholder, value, onChange }: GlobInputProps) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        className="flex-1 rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-primary"
      />
    </label>
  );
}

interface ResultRowProps {
  item: FlatResult;
  idx: number;
  active: boolean;
  vaults: string[];
  onHover: () => void;
  onClick: () => void;
}

function ResultRow({
  item,
  idx,
  active,
  vaults,
  onHover,
  onClick,
}: ResultRowProps) {
  const rel = relToVaultRow(item.path, vaults);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  // We use `role="button"` instead of `<button>` so the row body can
  // contain `<div>`s freely (HTML disallows block elements inside a
  // `<button>` and some browsers mis-render the flex children when it
  // happens).  The row is also `overflow-hidden` so a runaway-long
  // line of match text can't push the pane wider than its container.
  if (item.kind === "file") {
    return (
      <div
        role="button"
        tabIndex={0}
        data-row-index={idx}
        onMouseMove={onHover}
        onClick={onClick}
        onKeyDown={onKeyDown}
        title={item.path}
        className={cn(
          "flex w-full min-w-0 items-start gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-xs",
          active && "bg-accent text-accent-foreground",
        )}
      >
        <FileText className="mt-[2px] size-3.5 shrink-0 text-primary/70" />
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <div className="block w-full min-w-0 truncate font-medium">
            {basenameNoExt(item.path)}
          </div>
          <FrontTruncated text={rel} />
        </div>
      </div>
    );
  }

  // Content row — two lines:
  //   1. basename :line  match-snippet (truncated at the end)
  //   2. dim vault-relative path (truncated at the *front* so the
  //      filename + immediate parent dir stay visible)
  return (
    <div
      role="button"
      tabIndex={0}
      data-row-index={idx}
      onMouseMove={onHover}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={item.path}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-xs",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <TextSearch className="mt-[2px] size-3.5 shrink-0 text-fuchsia-500/70" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <div className="flex w-full min-w-0 items-baseline gap-2 overflow-hidden">
          <span className="shrink-0 font-mono text-[11px]">
            {basenameNoExt(item.path)}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            :{item.line}
          </span>
          <span className="block min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {item.text.trim()}
          </span>
        </div>
        <FrontTruncated text={rel} />
      </div>
    </div>
  );
}

/**
 * Render `text` truncated at the *front* with a leading ellipsis, so
 * the tail (basename + immediate parent dir) stays visible.
 *
 * CSS trick: `direction: rtl` flips where overflow happens — `text-
 * overflow: ellipsis` then renders on the visual left.  A `<bdi>`
 * wrapper isolates the actual string from the parent's bidi context
 * so forward slashes / characters keep their natural left-to-right
 * order regardless.  No JS-side measurement needed; the browser
 * recomputes on every layout, including dialog resize.
 */
function FrontTruncated({ text }: { text: string }) {
  return (
    <span
      className="block min-w-0 overflow-hidden whitespace-nowrap text-[10px] text-muted-foreground/55"
      style={{ direction: "rtl", textOverflow: "ellipsis" }}
    >
      <bdi>{text}</bdi>
    </span>
  );
}

/**
 * Strip the matching vault prefix off `absPath`.  Used both by rows
 * (to keep them narrow) and by the preview header.  When no vault
 * matches we fall back to the trailing path components so the row
 * never spills the user's full home directory.
 */
function relToVaultRow(absPath: string, vaults: string[]): string {
  for (const v of vaults) {
    if (absPath === v) return absPath.split("/").slice(-1)[0] ?? absPath;
    const prefix = v.endsWith("/") ? v : `${v}/`;
    if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  }
  return absPath;
}

/** Split a comma-or-newline-separated glob list into a clean array. */
function splitGlobs(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────────
// Preview pane — lazy-reads the highlighted file and renders a window
// of lines centred on the match (content mode) or the file's first
// chunk (files mode).  Reads are cached in a ref-backed map so
// arrow-key nav over a list is instant after the first read.
// ────────────────────────────────────────────────────────────────────────

const PREVIEW_CACHE_LIMIT = 64;
/** How many lines to show in files mode. */
const FILES_PREVIEW_LINES = 60;
/** How many lines on each side of the match line in content mode. */
const CONTENT_PREVIEW_PADDING = 18;

interface PreviewPaneProps {
  selected: FlatResult | null;
  /** Vault roots — used to strip absolute paths down to a tidy
   *  vault-relative display in the header. */
  vaults: string[];
}

function PreviewPane({ selected, vaults }: PreviewPaneProps) {
  // ── ALL hooks unconditionally at the top ────────────────────────
  // (React enforces stable hook order — early-returning between
  // `useState` and `useEffect` calls would crash with "Rendered
  // fewer hooks than expected".  Hoist + null-guard inside.)
  const cacheRef = useRef<Map<string, string>>(new Map());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const selectedPath = selected?.path ?? null;
  const selectedLine =
    selected?.kind === "content" ? selected.line : null;

  // Lazy file read with FIFO cache.
  useEffect(() => {
    if (!selectedPath) {
      setContent(null);
      setLoadingPath(null);
      return;
    }
    const cached = cacheRef.current.get(selectedPath);
    if (cached !== undefined) {
      setContent(cached);
      setLoadingPath(null);
      return;
    }
    let cancelled = false;
    setContent(null);
    setLoadingPath(selectedPath);
    void markdownTauri
      .readFile(selectedPath)
      .then((text) => {
        if (cancelled) return;
        cacheRef.current.set(selectedPath, text);
        if (cacheRef.current.size > PREVIEW_CACHE_LIMIT) {
          const first = cacheRef.current.keys().next().value;
          if (first) cacheRef.current.delete(first);
        }
        setContent(text);
        setLoadingPath(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[markdown] preview read failed", selectedPath, err);
        setContent(null);
        setLoadingPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  // Centre the matched line whenever it changes (content mode only).
  useEffect(() => {
    if (selectedLine == null) return;
    const el = viewportRef.current?.querySelector<HTMLElement>(
      `[data-preview-line="${selectedLine}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [selectedPath, selectedLine, content]);

  // ── Now safe to early-return ────────────────────────────────────
  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground/60">
        Pick a result to preview.
      </div>
    );
  }

  // Compute the line window.
  const allLines = (content ?? "").split("\n");
  const targetLine = selected.kind === "content" ? selected.line : 1;
  const windowStart =
    selected.kind === "content"
      ? Math.max(1, targetLine - CONTENT_PREVIEW_PADDING)
      : 1;
  const windowEnd =
    selected.kind === "content"
      ? Math.min(allLines.length, targetLine + CONTENT_PREVIEW_PADDING)
      : Math.min(allLines.length, FILES_PREVIEW_LINES);
  const windowLines = allLines.slice(windowStart - 1, windowEnd);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground/80">
        <span className="truncate font-mono">
          {relToVault(selected.path, vaults)}
        </span>
        {selected.kind === "content" ? (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">
            line {selected.line}
          </span>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto bg-background"
      >
        {loadingPath === selected.path ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            Loading preview…
          </div>
        ) : content == null ? (
          <div className="px-3 py-2 text-xs text-muted-foreground/60">
            Couldn't read file.
          </div>
        ) : (
          <pre className="px-2 py-1.5 font-mono text-[11px] leading-relaxed">
            {windowLines.map((text, i) => {
              const lineNo = windowStart + i;
              const isMatch =
                selected.kind === "content" && lineNo === targetLine;
              return (
                <div
                  key={lineNo}
                  data-preview-line={lineNo}
                  className={cn(
                    "flex gap-2 whitespace-pre",
                    isMatch
                      ? "bg-amber-500/20 font-semibold text-foreground"
                      : "text-muted-foreground/85",
                  )}
                >
                  <span className="w-10 shrink-0 select-none text-right tabular-nums text-muted-foreground/40">
                    {lineNo}
                  </span>
                  <span className="break-words">{text || " "}</span>
                </div>
              );
            })}
            {selected.kind === "file" && allLines.length > windowEnd ? (
              <div className="mt-1 px-2 text-[10px] italic text-muted-foreground/50">
                … {allLines.length - windowEnd} more line
                {allLines.length - windowEnd === 1 ? "" : "s"}
              </div>
            ) : null}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Strip the matching vault prefix off `absPath`.  When no vault matches
 * (shouldn't happen but safe) returns the absolute path unchanged.
 */
function relToVault(absPath: string, vaults: string[]): string {
  for (const v of vaults) {
    if (absPath === v) return absPath.split("/").slice(-1)[0] ?? absPath;
    const prefix = v.endsWith("/") ? v : `${v}/`;
    if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  }
  return absPath;
}
