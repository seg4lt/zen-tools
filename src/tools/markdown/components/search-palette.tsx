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
import {
  PICKER_RESULT_LIMIT,
  rankFuzzy,
  rankSubstring,
} from "../lib/file-rank";
import { useMarkdownStore, type SearchMode } from "../store/markdown-store";
import { useOpenFile } from "../hooks/use-open-file";

/** Match Flowstate's debounce so type-and-wait feels identical. */
const CONTENT_SEARCH_DEBOUNCE_MS = 600;

/** Flat result row used by the keyboard-nav code below. */
type FlatResult =
  | { kind: "file"; path: string; key: string }
  | {
      kind: "content";
      path: string;
      line: number;
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

  // ── File-mode results (synchronous, client-side) ───────────────
  const fileResults = useMemo(() => {
    if (mode !== "files") return [];
    if (!query.trim()) {
      // Empty query: surface recents first, then everything else.
      const recentSet = new Set(state.recents);
      const recentsHere = state.recents.filter((p) =>
        recentSet.has(p) ? allMarkdownPaths.includes(p) : false,
      );
      const rest = allMarkdownPaths.filter((p) => !recentSet.has(p));
      return [...recentsHere, ...rest].slice(0, PICKER_RESULT_LIMIT);
    }
    return useFuzzy
      ? rankFuzzy(allMarkdownPaths, query)
      : rankSubstring(allMarkdownPaths, query);
  }, [mode, query, useFuzzy, allMarkdownPaths, state.recents]);

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
          useRegex,
          caseSensitive,
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
      void openFile(item.path);
      // We don't currently scroll the editor to a specific line —
      // openFile drops focus there, the line jump can come later.
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
        className="max-w-2xl gap-0 p-0"
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
                icon={Regex}
                label="Regex"
                active={useRegex}
                onToggle={() => setUseRegex((v) => !v)}
              />
              <OptionToggle
                icon={CaseSensitive}
                label="Case"
                active={caseSensitive}
                onToggle={() => setCaseSensitive((v) => !v)}
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

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-[60vh] min-h-[200px] overflow-y-auto p-1"
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
              onHover={() => setHighlightIdx(idx)}
              onClick={() => commit(idx)}
            />
          ))}
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
}

function OptionToggle({
  icon: Icon,
  label,
  active,
  onToggle,
}: OptionToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${label}: ${active ? "on" : "off"}`}
      aria-pressed={active}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
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
  onHover: () => void;
  onClick: () => void;
}

function ResultRow({ item, idx, active, onHover, onClick }: ResultRowProps) {
  return (
    <button
      type="button"
      data-row-index={idx}
      onMouseMove={onHover}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {item.kind === "file" ? (
        <>
          <FileText className="size-3.5 shrink-0 text-primary/70" />
          <span className="truncate">
            <span className="font-medium">{basenameNoExt(item.path)}</span>
            <span className="ml-2 text-[10px] text-muted-foreground/60">
              {item.path}
            </span>
          </span>
        </>
      ) : (
        <>
          <TextSearch className="size-3.5 shrink-0 text-fuchsia-500/70" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono text-[11px]">
              {basenameNoExt(item.path)}
            </span>
            <span className="ml-2 text-[10px] text-muted-foreground/60">
              :{item.line}
            </span>
            <span className="ml-2 truncate font-mono text-[11px] text-muted-foreground">
              {item.text.trim()}
            </span>
          </span>
        </>
      )}
    </button>
  );
}

/** Split a comma-or-newline-separated glob list into a clean array. */
function splitGlobs(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
