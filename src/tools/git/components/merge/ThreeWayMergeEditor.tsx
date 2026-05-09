/**
 * 3-way merge editor — VSCode-style.
 *
 *   ┌──────── LOCAL (HEAD) ────────┬──────── REMOTE (incoming) ────────┐
 *   │  read-only blob              │  read-only blob                   │
 *   ├───────────────────────────── RESULT (editable) ──────────────────┤
 *   │  worktree contents — accept-left/right/both/manual rewrites here │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * The middle "BASE" pane is shown when the user toggles it on (defaults
 * off, matching VSCode).
 *
 * Implementation: parse the worktree file's conflict markers (left in
 * place by `git merge`); each block exposes accept-local / accept-
 * remote / accept-both buttons + manual edit. Rebuilding the file
 * produces a clean version with markers stripped, ready for
 * `git_write_resolved` + `git_stage_path`.
 */

import { CodeEditor, type CodeEditorHandle } from "@zen-tools/editor";
import { Button, cn } from "@zen-tools/ui";
import type { EditorView } from "@codemirror/view";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Redo2,
  Undo2,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLanguageExtension } from "../../lib/use-language-extension";
import { Split } from "../shared/Split";
import {
  buildResolvedText,
  buildResultView,
  buildSideView,
  magicMerge,
  mapLineBetweenSides,
  parseConflicts,
  unresolvedCount,
  type BlockLineRange,
  type ParsedConflicts,
  type Resolution,
} from "./conflict-parser";
import { HunkConnector, type HunkPair } from "./HunkConnector";
import {
  dispatchHunks,
  hunkHighlight,
  scrollToHunk,
  type HunkSpan,
} from "./hunk-highlight";
import "./merge-editor.css";

export interface ThreeWayMergeEditorProps {
  isDark: boolean;
  /** Stage 2 ("ours" / HEAD) blob, read-only. */
  local: string | null;
  /** Stage 3 ("theirs" / incoming) blob, read-only. */
  remote: string | null;
  /** Stage 1 (common ancestor) blob, read-only. Optional — hidden behind a toggle. */
  base: string | null;
  /** Worktree file (with `<<<<<<<` markers). The editor uses this as
   *  the seed for the editable RESULT pane. */
  working: string;
  /** Persist + stage the user's edited result. */
  onMarkResolved: (content: string) => Promise<void> | void;
  /** Notify parent so it can update its "unresolved" counter for the
   *  file list rail. Called whenever a block flips to/from resolved. */
  onUnresolvedChanged?: (unresolved: number, total: number) => void;
  /** Filename for the RESULT-pane title bar. */
  fileName: string;
}

export function ThreeWayMergeEditor({
  isDark,
  local,
  remote,
  base,
  working,
  onMarkResolved,
  onUnresolvedChanged,
  fileName,
}: ThreeWayMergeEditorProps) {
  const [showBase, setShowBase] = useState(false);
  const [parsed, setParsed] = useState<ParsedConflicts>(() =>
    parseConflicts(working),
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const resultRef = useRef<CodeEditorHandle | null>(null);

  // Undo/redo stack for resolution-level changes (Accept LOCAL /
  // REMOTE / BOTH / Mark resolved). Free-text edits inside the RESULT
  // pane go through CodeMirror's own history extension (Cmd-Z works
  // there directly). The stacks are bounded so a long session
  // doesn't grow memory unboundedly.
  const HISTORY_CAP = 100;
  const [past, setPast] = useState<ParsedConflicts[]>([]);
  const [future, setFuture] = useState<ParsedConflicts[]>([]);

  // Counter for in-flight programmatic writes to the RESULT editor.
  // Bumped by `applyParsed` / `undo` / `redo` before calling
  // `setValue`; decremented inside `onResultChange` so a real user
  // keystroke (counter == 0) flows through the parser, while our
  // own setValue-echo (counter > 0) is dropped on the floor. Without
  // this, our `setValue` would feed back into `onResultChange` →
  // re-parse → overwrite the resolution data we just applied.
  const programmaticEchoesRef = useRef(0);

  const writeResultPane = useCallback((text: string) => {
    const current = resultRef.current?.getValue() ?? "";
    if (current === text) return;
    programmaticEchoesRef.current += 1;
    resultRef.current?.setValue(text);
  }, []);

  /**
   * Apply a new parsed-conflicts state, pushing the previous one onto
   * the undo stack and dropping any pending redo. Also pushes the
   * rebuilt text into the RESULT editor so the visible buffer stays
   * in sync with the structured state.
   */
  const applyParsed = useCallback(
    (next: ParsedConflicts) => {
      setPast((p) => {
        const trimmed = p.length >= HISTORY_CAP ? p.slice(1) : p;
        return [...trimmed, parsed];
      });
      setFuture([]);
      setParsed(next);
      writeResultPane(buildResolvedText(next));
    },
    [parsed, writeResultPane],
  );

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [parsed, ...f].slice(0, HISTORY_CAP));
    setParsed(prev);
    writeResultPane(buildResolvedText(prev));
  }, [past, parsed, writeResultPane]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => {
      const trimmed = p.length >= HISTORY_CAP ? p.slice(1) : p;
      return [...trimmed, parsed];
    });
    setParsed(next);
    writeResultPane(buildResolvedText(next));
  }, [future, parsed, writeResultPane]);

  // Language extension for syntax highlighting — lazy-loaded based on
  // the active file's extension via `@codemirror/language-data`. We
  // gate the editor mount on `langReady` so the language is always
  // attached at first mount. The shared `<CodeEditor>` reads
  // `extensions` only at mount time; we don't want to remount mid-
  // typing (that would clobber the user's RESULT-pane edits). The
  // initial state is computed synchronously from the registry, so
  // every cached language type is `ready=true` on the first render
  // and only first-time loads of a brand-new extension see a brief
  // "Loading editor…" placeholder.
  const { extensions: langExts, ready: langReady } =
    useLanguageExtension(fileName);
  const buildExtensions = useCallback(
    () => [...langExts, hunkHighlight],
    [langExts],
  );

  // Reconstructed views — text + line ranges per conflict block —
  // for each pane. LOCAL / REMOTE / BASE are derived from
  // `block.local|remote|base` and stay constant for a given file
  // (only the `resolution` flag changes as the user clicks accept,
  // and that doesn't affect the side blobs themselves). RESULT
  // changes whenever resolutions change because we emit the chosen
  // lines instead of markers.
  const localView = useMemo(() => buildSideView(parsed, "local"), [parsed]);
  const remoteView = useMemo(() => buildSideView(parsed, "remote"), [parsed]);
  const baseView = useMemo(() => buildSideView(parsed, "base"), [parsed]);
  const resultView = useMemo(() => buildResultView(parsed), [parsed]);

  // Captured `EditorView` instances for each pane, set via the
  // CodeEditor `onView` callback. Used to dispatch hunk-highlight
  // effects and to drive `<HunkConnector>` ribbon coordinates.
  const localViewRef = useRef<EditorView | null>(null);
  const remoteViewRef = useRef<EditorView | null>(null);
  const baseViewRef = useRef<EditorView | null>(null);
  const resultViewRef = useRef<EditorView | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const bumpViewVersion = useCallback(() => setViewVersion((v) => v + 1), []);

  // Use props as a fallback when the parser yielded nothing useful
  // (e.g. file already fully resolved on disk). Suppresses the
  // "unused prop" warning while keeping the surface flexible.
  void local;
  void remote;
  void base;

  // Re-parse if the worktree file changed under us (e.g. `git merge`
  // re-ran, or user picked another file).
  useEffect(() => {
    setParsed(parseConflicts(working));
    setActiveIdx(0);
  }, [working, fileName]);

  const conflictBlocks = useMemo(
    () =>
      parsed.segments
        .map((s, i) => (s.type === "conflict" ? { ...s.block, segIdx: i } : null))
        .filter((b): b is NonNullable<typeof b> => b !== null),
    [parsed],
  );

  const unresolved = unresolvedCount(parsed);
  useEffect(() => {
    onUnresolvedChanged?.(unresolved, parsed.total);
  }, [unresolved, parsed.total, onUnresolvedChanged]);

  const setResolution = useCallback(
    (blockId: string, res: Resolution) => {
      const next: ParsedConflicts = {
        ...parsed,
        segments: parsed.segments.map((s) =>
          s.type === "conflict" && s.block.id === blockId
            ? { ...s, block: { ...s.block, resolution: res } }
            : s,
        ),
      };
      applyParsed(next);
    },
    [parsed, applyParsed],
  );

  /**
   * "Magic merge" — auto-resolve every unambiguous block in one
   * batch. Routes through `applyParsed` so the whole sweep is
   * undoable as a single step. The flash message is held for a
   * couple of seconds so the user sees what just happened.
   *
   * Reads `magicPreview` (memoised below) instead of re-running the
   * merge so the click is instant and the dim/enable state of the
   * button matches exactly what clicking it will do.
   */
  const [magicFlash, setMagicFlash] = useState<string | null>(null);

  // Auto-clear the magic-merge flash after a few seconds so the
  // toolbar doesn't stay shouty forever.
  useEffect(() => {
    if (!magicFlash) return;
    const t = setTimeout(() => setMagicFlash(null), 3500);
    return () => clearTimeout(t);
  }, [magicFlash]);

  // Probe the merge without committing it so the toolbar button can
  // dim/enable accurately. Memoised on `parsed`, which is exactly
  // when the merge result could change. node-diff3 is fast (single
  // Myers pass per block) and merges of the demo's biggest file
  // (15 blocks ≈ 400 lines) clock in well under a millisecond, so
  // running this on every parsed change is fine.
  const magicPreview = useMemo(() => magicMerge(parsed), [parsed]);
  // Anything productive: a clean resolution OR a partial merge that
  // shrinks the surface area by splitting a block.
  const canMagicMerge = magicPreview.resolved > 0 || magicPreview.split > 0;

  const runMagicMerge = useCallback(() => {
    if (!canMagicMerge) {
      setMagicFlash(
        magicPreview.unresolved === 0 && magicPreview.resolved === 0
          ? "Nothing to merge — all blocks already resolved."
          : "Magic merge can't help here — every remaining conflict has both sides editing the same lines differently.",
      );
      return;
    }
    applyParsed(magicPreview.parsed);
    const breakdown: string[] = [];
    const s = magicPreview.byStrategy;
    if (s.diff3Clean > 0)
      breakdown.push(`${s.diff3Clean} via line-level 3-way merge`);
    if (s.diff3Partial > 0)
      breakdown.push(
        `${s.diff3Partial} block${s.diff3Partial === 1 ? "" : "s"} split into smaller sub-conflicts`,
      );
    if (s.localUnchanged > 0)
      breakdown.push(`${s.localUnchanged} local-untouched`);
    if (s.remoteUnchanged > 0)
      breakdown.push(`${s.remoteUnchanged} remote-untouched`);
    if (s.identical > 0) breakdown.push(`${s.identical} identical`);
    const parts: string[] = [];
    if (magicPreview.resolved > 0)
      parts.push(
        `Auto-resolved ${magicPreview.resolved} block${
          magicPreview.resolved === 1 ? "" : "s"
        }`,
      );
    if (magicPreview.split > 0 && magicPreview.resolved === 0)
      parts.push(
        `Shrunk ${magicPreview.split} large conflict${
          magicPreview.split === 1 ? "" : "s"
        } into smaller sub-conflicts`,
      );
    const tail =
      magicPreview.unresolved > 0
        ? ` — ${magicPreview.unresolved} block${
            magicPreview.unresolved === 1 ? "" : "s"
          } still need a manual choice.`
        : ".";
    setMagicFlash(
      `${parts.join("; ")} (${breakdown.join(", ")})${tail}`,
    );
  }, [magicPreview, canMagicMerge, applyParsed]);

  const onResultChange = (value: string) => {
    // Drop self-feedback from our own programmatic setValue calls —
    // those carry resolution info in `parsed` that we mustn't lose
    // by re-parsing the rebuilt text (which has no markers for
    // resolved blocks).
    if (programmaticEchoesRef.current > 0) {
      programmaticEchoesRef.current -= 1;
      return;
    }
    // The user typed in the RESULT pane directly — re-parse the
    // text to pick up any conflict-marker changes (e.g. they
    // manually deleted a block).
    setParsed(parseConflicts(value));
  };

  const onMark = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const text = resultRef.current?.getValue() ?? buildResolvedText(parsed);
      await onMarkResolved(text);
    } finally {
      setBusy(false);
    }
  };

  const navigate = (delta: 1 | -1) => {
    if (conflictBlocks.length === 0) return;
    setActiveIdx((i) => {
      const next =
        (i + delta + conflictBlocks.length) % conflictBlocks.length;
      return next;
    });
  };

  const activeBlock = conflictBlocks[activeIdx] ?? null;

  // Effect 1 — paint hunk highlights. Broad deps: re-fires on every
  // structural change (typed edits, accept-side clicks, file mount)
  // so the colored backgrounds always reflect the current state.
  // Decorations are cheap and don't move the user's viewport.
  useEffect(() => {
    const activeId = activeBlock?.id ?? null;
    const toSpans = (
      ranges: BlockLineRange[],
      variant: HunkSpan["variant"],
    ): HunkSpan[] =>
      ranges.map((r) => ({
        fromLine: r.fromLine,
        toLine: r.toLine,
        active: r.blockId === activeId,
        variant,
      }));

    const local = localViewRef.current;
    const remote = remoteViewRef.current;
    const base = baseViewRef.current;
    const result = resultViewRef.current;
    if (local) dispatchHunks(local, toSpans(localView.ranges, "local"));
    if (remote) dispatchHunks(remote, toSpans(remoteView.ranges, "remote"));
    if (base) dispatchHunks(base, toSpans(baseView.ranges, "base"));
    if (result) dispatchHunks(result, toSpans(resultView.ranges, "result"));
  }, [
    parsed,
    activeBlock,
    viewVersion,
    localView,
    remoteView,
    baseView,
    resultView,
  ]);

  // Effect 2 — center the active conflict in every pane. NARROW
  // deps: fires only when the user explicitly navigates (F7 /
  // Shift+F7 / accept-side click that advances the active conflict)
  // or when a pane first becomes available (`viewVersion` bumps
  // once per `onView`). We deliberately exclude `parsed` so a
  // keystroke in the RESULT pane doesn't snap every pane back to
  // the active hunk and lock the user out of scrolling.
  useEffect(() => {
    const activeId = activeBlock?.id ?? null;
    if (!activeId) return;
    const local = localViewRef.current;
    const remote = remoteViewRef.current;
    const base = baseViewRef.current;
    const result = resultViewRef.current;
    const localR = localView.ranges.find((r) => r.blockId === activeId);
    const remoteR = remoteView.ranges.find((r) => r.blockId === activeId);
    const baseR = baseView.ranges.find((r) => r.blockId === activeId);
    const resultR = resultView.ranges.find((r) => r.blockId === activeId);
    if (local && localR) scrollToHunk(local, localR.fromLine);
    if (remote && remoteR) scrollToHunk(remote, remoteR.fromLine);
    if (base && baseR) scrollToHunk(base, baseR.fromLine);
    if (result && resultR) scrollToHunk(result, resultR.fromLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, fileName, viewVersion]);

  // Pairs (LOCAL ↔ REMOTE block ranges) that the connector renders.
  const connectorPairs: HunkPair[] = useMemo(() => {
    const localById = new Map(
      localView.ranges.map((r) => [r.blockId, r] as const),
    );
    const remoteById = new Map(
      remoteView.ranges.map((r) => [r.blockId, r] as const),
    );
    const activeId = activeBlock?.id ?? null;
    return conflictBlocks
      .map((b) => {
        const l = localById.get(b.id);
        const r = remoteById.get(b.id);
        if (!l || !r) return null;
        return {
          blockId: b.id,
          localFrom: l.fromLine,
          localTo: l.toLine,
          remoteFrom: r.fromLine,
          remoteTo: r.toLine,
          active: b.id === activeId,
          resolved: b.resolution !== null,
        } as HunkPair;
      })
      .filter((x): x is HunkPair => x !== null);
  }, [conflictBlocks, localView.ranges, remoteView.ranges, activeBlock]);

  // Line-aligned sync scroll between LOCAL and REMOTE. Pixel-lock
  // is wrong when the two sides have different lengths — same y
  // position lands on different logical lines. Instead we:
  //   1. find the topmost visible line on the source pane
  //   2. map that line to the partner's coordinate space via
  //      `mapLineBetweenSides` (1:1 in context, proportional inside
  //       a conflict block)
  //   3. set partner's scrollTop to the y of that mapped line
  //
  // Refs hold the latest ranges so the listeners don't have to
  // re-attach on every parsed change (would clobber any in-flight
  // scroll). `syncing` short-circuits the partner's echo so the
  // mirror write doesn't bounce.
  const localRangesRef = useRef(localView.ranges);
  const remoteRangesRef = useRef(remoteView.ranges);
  useEffect(() => {
    localRangesRef.current = localView.ranges;
    remoteRangesRef.current = remoteView.ranges;
  }, [localView.ranges, remoteView.ranges]);

  useEffect(() => {
    const local = localViewRef.current;
    const remote = remoteViewRef.current;
    if (!local || !remote) return;
    const localDom = local.scrollDOM;
    const remoteDom = remote.scrollDOM;

    // Value-matching de-bounce: each side remembers the last
    // `scrollTop` we *programmatically* wrote into it. The echo
    // scroll event lands with that exact value (within rounding),
    // so the partner's handler can recognise it as our own write
    // and skip mirroring back. A timer-based release (`syncing`
    // flag + RAF / setTimeout) is unreliable: continuous wheel
    // scrolling fires more events than the timer can clear, and
    // late-arriving echoes get treated as fresh user scrolls and
    // ricochet the user's position. Value-matching has no timing
    // dependency.
    let pendingLocalSet: number | null = null;
    let pendingRemoteSet: number | null = null;
    const TOLERANCE = 1; // px — sub-pixel rounding from CodeMirror

    /** Top visible 1-based line in `view`. */
    const topLine = (view: typeof local): number => {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number;
    };

    /** Pixel-y of `line` (1-based) inside `view`'s content. */
    const lineTopY = (view: typeof local, line: number): number => {
      const total = view.state.doc.lines;
      const target = Math.max(1, Math.min(total, line));
      const pos = view.state.doc.line(target).from;
      return view.lineBlockAt(pos).top;
    };

    const onLocal = () => {
      // If we just wrote this scrollTop into LOCAL ourselves, it's
      // an echo of a remote-driven mirror — drop it and clear the
      // marker so the next genuine user scroll passes through.
      if (
        pendingLocalSet !== null &&
        Math.abs(localDom.scrollTop - pendingLocalSet) <= TOLERANCE
      ) {
        pendingLocalSet = null;
        return;
      }
      pendingLocalSet = null;
      const fromLine = topLine(local);
      const toLine = mapLineBetweenSides(
        localRangesRef.current,
        remoteRangesRef.current,
        fromLine,
      );
      const target = lineTopY(remote, toLine);
      if (Math.abs(remoteDom.scrollTop - target) <= TOLERANCE) return;
      pendingRemoteSet = target;
      remoteDom.scrollTop = target;
    };
    const onRemote = () => {
      if (
        pendingRemoteSet !== null &&
        Math.abs(remoteDom.scrollTop - pendingRemoteSet) <= TOLERANCE
      ) {
        pendingRemoteSet = null;
        return;
      }
      pendingRemoteSet = null;
      const fromLine = topLine(remote);
      const toLine = mapLineBetweenSides(
        remoteRangesRef.current,
        localRangesRef.current,
        fromLine,
      );
      const target = lineTopY(local, toLine);
      if (Math.abs(localDom.scrollTop - target) <= TOLERANCE) return;
      pendingLocalSet = target;
      localDom.scrollTop = target;
    };
    localDom.addEventListener("scroll", onLocal, { passive: true });
    remoteDom.addEventListener("scroll", onRemote, { passive: true });
    return () => {
      localDom.removeEventListener("scroll", onLocal);
      remoteDom.removeEventListener("scroll", onRemote);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewVersion]);

  const acceptLocalById = useCallback(
    (id: string) => setResolution(id, { kind: "local" }),
    [setResolution],
  );
  const acceptRemoteById = useCallback(
    (id: string) => setResolution(id, { kind: "remote" }),
    [setResolution],
  );

  // Keyboard shortcuts: F7 / Shift+F7 (next/prev conflict),
  // Cmd-Z / Cmd-Shift-Z (resolution-level undo/redo). The undo
  // shortcut is *only* handled when focus is outside a CodeMirror
  // editor — when focus is inside the RESULT pane, CodeMirror's own
  // history extension owns Cmd-Z so the user can undo their typed
  // edits character-by-character.
  useEffect(() => {
    const isInsideEditor = (target: EventTarget | null): boolean => {
      let el = target as HTMLElement | null;
      while (el) {
        if (el.classList?.contains("cm-editor") || el.classList?.contains("cm-content")) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F7") {
        e.preventDefault();
        navigate(e.shiftKey ? -1 : 1);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "z" || e.key === "Z")) {
        if (isInsideEditor(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [conflictBlocks.length, undo, redo]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Conflict-nav toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={fileName}
        >
          {fileName}
        </span>
        <span className="shrink-0">
          {conflictBlocks.length === 0
            ? "no conflicts"
            : `${activeIdx + 1} / ${conflictBlocks.length}`}{" "}
          <span className="text-muted-foreground">
            ({unresolved} unresolved)
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={undo}
            disabled={!canUndo}
            title={`Undo last resolution (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}Z)`}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={redo}
            disabled={!canRedo}
            title={`Redo (${navigator.platform.includes("Mac") ? "⇧⌘" : "Ctrl+Shift+"}Z)`}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Button
            size="sm"
            variant={canMagicMerge ? "secondary" : "ghost"}
            onClick={runMagicMerge}
            disabled={!canMagicMerge}
            title="Magic merge — auto-resolve every block where one side is unchanged from base or both sides made the same change. Undoable with ⌘Z."
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Magic merge
          </Button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => navigate(-1)}
            title="Previous conflict (Shift+F7)"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => navigate(1)}
            title="Next conflict (F7)"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant={showBase ? "secondary" : "ghost"}
            onClick={() => setShowBase((v) => !v)}
            title={showBase ? "Hide base pane" : "Show base pane"}
            className="h-7 gap-1 px-2 text-[11px]"
          >
            {showBase ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {showBase ? "Hide base" : "Show base"}
          </Button>
          <Button size="sm" onClick={onMark} disabled={busy}>
            Mark resolved
          </Button>
        </div>
      </div>

      {/* Magic-merge flash — auto-clears after a few seconds. */}
      {magicFlash && (
        <div
          role="status"
          className="border-b border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[11px] text-violet-700 dark:text-violet-300"
        >
          ✨ {magicFlash}
        </div>
      )}

      {/* Per-conflict toolbar — every button here resolves the
          *active* conflict by writing into the structured `parsed`
          state, which then rebuilds the RESULT pane. The verb
          prefix ("Use") + colour-coded chip make it obvious this
          is a resolution action, not a view toggle. (The "Show
          base" button up in the main toolbar is the visibility
          toggle for the BASE pane and is separate.) */}
      {activeBlock && (
        <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-3 py-1 text-[11px]">
          <span className="shrink-0 text-muted-foreground">
            Conflict #{activeIdx + 1} —
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 border-rose-500/40 px-2 text-[11px] text-rose-600 hover:bg-rose-500/10"
            onClick={() => setResolution(activeBlock.id, { kind: "local" })}
            title="Replace this conflict with the LOCAL (HEAD) lines"
          >
            <span className="inline-block h-2 w-2 rounded-sm bg-rose-500" />
            Use Local
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 border-emerald-500/40 px-2 text-[11px] text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
            onClick={() => setResolution(activeBlock.id, { kind: "remote" })}
            title="Replace this conflict with the REMOTE (incoming) lines"
          >
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            Use Remote
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              setResolution(activeBlock.id, {
                kind: "both",
                order: "localFirst",
              })
            }
            title="Use LOCAL lines followed by REMOTE lines"
          >
            Use Both (L→R)
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              setResolution(activeBlock.id, {
                kind: "both",
                order: "remoteFirst",
              })
            }
            title="Use REMOTE lines followed by LOCAL lines"
          >
            Use Both (R→L)
          </Button>
          {activeBlock.base !== null && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 border-amber-500/40 px-2 text-[11px] text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
              onClick={() => setResolution(activeBlock.id, { kind: "base" })}
              title="Discard both sides and revert to the common ancestor's lines"
            >
              <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
              Revert to Base
            </Button>
          )}
          {activeBlock.resolution !== null && (
            <button
              type="button"
              onClick={() => setResolution(activeBlock.id, null)}
              title="Clear this resolution and put the conflict markers back"
              className="ml-2 rounded bg-emerald-500/10 px-1.5 py-px font-mono text-[10px] text-emerald-600 hover:bg-emerald-500/20"
            >
              resolved · clear
            </button>
          )}
        </div>
      )}

      {/* Panes — top row holds LOCAL ↔ REMOTE (with the connector
          strip between them), bottom row is the editable RESULT.
          Drag the divider between them to claim more space. */}
      {!langReady ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading editor…
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Split
            direction="vertical"
            storageKey="merge.editor.topResult"
            defaultFirst={300}
            minFirst={120}
            minSecond={120}
          >
            <div className="flex h-full min-h-0 min-w-0">
              {/* LOCAL */}
              <Pane title="LOCAL (HEAD)" tone="local">
                <CodeEditor
                  value={localView.text}
                  readOnly
                  isDark={isDark}
                  extensions={buildExtensions}
                  vimMode={false}
                  onView={(v) => {
                    localViewRef.current = v;
                    bumpViewVersion();
                  }}
                />
              </Pane>

              {/* BASE pane (toggleable) */}
              {showBase && (
                <Pane title="BASE (ancestor)" tone="base">
                  <CodeEditor
                    value={baseView.text}
                    readOnly
                    isDark={isDark}
                    extensions={buildExtensions}
                    vimMode={false}
                    onView={(v) => {
                      baseViewRef.current = v;
                      bumpViewVersion();
                    }}
                  />
                </Pane>
              )}

              {/* Connector ribbons + accept-side arrows. Hidden when
                  BASE is showing (with three panes the visual link
                  gets ambiguous; the per-conflict toolbar still
                  exposes Local / Remote / Base buttons). */}
              {!showBase && (
                <HunkConnector
                  pairs={connectorPairs}
                  localView={localViewRef.current}
                  remoteView={remoteViewRef.current}
                  onAcceptLocal={acceptLocalById}
                  onAcceptRemote={acceptRemoteById}
                />
              )}

              {/* REMOTE */}
              <Pane title="REMOTE (incoming)" tone="remote">
                <CodeEditor
                  value={remoteView.text}
                  readOnly
                  isDark={isDark}
                  extensions={buildExtensions}
                  vimMode={false}
                  onView={(v) => {
                    remoteViewRef.current = v;
                    bumpViewVersion();
                  }}
                />
              </Pane>
            </div>

            <Pane title="RESULT" tone="result">
              <CodeEditor
                imperativeRef={resultRef}
                value={working}
                isDark={isDark}
                onChange={onResultChange}
                extensions={buildExtensions}
                vimMode={false}
                onView={(v) => {
                  resultViewRef.current = v;
                  bumpViewVersion();
                }}
              />
            </Pane>
          </Split>
        </div>
      )}
    </div>
  );
}

function Pane({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "local" | "remote" | "base" | "result";
  children: React.ReactNode;
}) {
  const colors: Record<typeof tone, string> = {
    local: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    remote: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    base: "bg-muted text-muted-foreground",
    result: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  };
  // `h-full` makes the pane fill its container regardless of whether
  // the parent is a flex layout (top row of the editor) or a plain
  // block (the vertical Split's bottom wrapper). `flex-1` is kept
  // for the flex-row case so multiple panes share width evenly. The
  // inner column uses `min-h-0` so the editor's content can shrink
  // and the `.cm-scroller` actually scrolls.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={cn(
          "border-b px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
          colors[tone],
        )}
      >
        {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
