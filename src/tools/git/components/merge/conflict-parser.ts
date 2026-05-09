/**
 * Parse a worktree file containing conflict markers (the form `git merge`
 * leaves behind by default) into a structured `ParsedConflicts` payload
 * the 3-way editor can render.
 *
 * Standard form:
 *   <<<<<<< <local-label>
 *   …local lines…
 *   =======
 *   …remote lines…
 *   >>>>>>> <remote-label>
 *
 * `merge.conflictStyle = diff3` extends with a base block:
 *   <<<<<<< <local-label>
 *   …local lines…
 *   ||||||| <base-label>
 *   …base lines…
 *   =======
 *   …remote lines…
 *   >>>>>>> <remote-label>
 *
 * The parser tolerates either form. Anything between two conflict
 * blocks is "context" — emitted verbatim into the result so callers
 * can rebuild the file post-resolution.
 */

/** User-chosen resolution for a single conflict block. */
export type Resolution =
  | null
  | { kind: "local" }
  | { kind: "remote" }
  | { kind: "base" }
  | { kind: "both"; order: "localFirst" | "remoteFirst" }
  | { kind: "custom"; lines: string[] };

export interface ConflictBlock {
  /** Stable id for React keys. */
  id: string;
  /** Label following `<<<<<<<`. */
  localLabel: string;
  /** Label following `>>>>>>>`. */
  remoteLabel: string;
  /** Local-side lines (no markers). */
  local: string[];
  /** Base lines, when diff3 style was used. */
  base: string[] | null;
  /** Remote-side lines (no markers). */
  remote: string[];
  /** User's choice — `null` while unresolved. */
  resolution: Resolution;
}

export type Segment =
  | { type: "context"; lines: string[] }
  | { type: "conflict"; block: ConflictBlock };

export interface ParsedConflicts {
  /** Source file split into context segments + conflict blocks. */
  segments: Segment[];
  /** Quick lookup for total/unresolved counts. */
  total: number;
}

const RE_OPEN = /^<{7}\s?(.*)$/;
const RE_BASE = /^\|{7}\s?(.*)$/;
const RE_SPLIT = /^={7}\s*$/;
const RE_CLOSE = /^>{7}\s?(.*)$/;

/** True if this file contains any conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return RE_OPEN.test(text) || /\n<{7}\s?/.test(text);
}

/** Parse `text` (the worktree contents) into segments. */
export function parseConflicts(text: string): ParsedConflicts {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let context: string[] = [];
  let i = 0;
  let nextId = 0;

  while (i < lines.length) {
    const m = RE_OPEN.exec(lines[i]);
    if (!m) {
      context.push(lines[i]);
      i++;
      continue;
    }
    if (context.length > 0) {
      segments.push({ type: "context", lines: context });
      context = [];
    }
    const localLabel = m[1].trim();
    const localLines: string[] = [];
    let baseLines: string[] | null = null;
    const remoteLines: string[] = [];
    let stage: "local" | "base" | "remote" = "local";
    let remoteLabel = "";
    i++;

    while (i < lines.length) {
      const ln = lines[i];
      if (stage !== "remote" && RE_BASE.test(ln)) {
        baseLines = [];
        stage = "base";
        i++;
        continue;
      }
      if (RE_SPLIT.test(ln)) {
        stage = "remote";
        i++;
        continue;
      }
      const c = RE_CLOSE.exec(ln);
      if (c) {
        remoteLabel = c[1].trim();
        i++;
        break;
      }
      if (stage === "local") localLines.push(ln);
      else if (stage === "base") baseLines!.push(ln);
      else remoteLines.push(ln);
      i++;
    }

    segments.push({
      type: "conflict",
      block: {
        id: `c${nextId++}`,
        localLabel,
        remoteLabel,
        local: localLines,
        base: baseLines,
        remote: remoteLines,
        resolution: null,
      },
    });
  }
  if (context.length > 0) {
    segments.push({ type: "context", lines: context });
  }

  const total = segments.filter((s) => s.type === "conflict").length;
  return { segments, total };
}

/** Rebuild the file content from a (possibly partially-resolved)
 * `ParsedConflicts`. Conflicts without a resolution are re-emitted
 * with their original markers so re-saving doesn't lose information. */
export function buildResolvedText(parsed: ParsedConflicts): string {
  const out: string[] = [];
  for (const seg of parsed.segments) {
    if (seg.type === "context") {
      out.push(...seg.lines);
      continue;
    }
    const b = seg.block;
    const r = b.resolution;
    if (r === null) {
      out.push(`<<<<<<< ${b.localLabel}`);
      out.push(...b.local);
      if (b.base) {
        out.push(`||||||| ${b.localLabel}`);
        out.push(...b.base);
      }
      out.push("=======");
      out.push(...b.remote);
      out.push(`>>>>>>> ${b.remoteLabel}`);
      continue;
    }
    if (r.kind === "local") out.push(...b.local);
    else if (r.kind === "remote") out.push(...b.remote);
    else if (r.kind === "base") out.push(...(b.base ?? []));
    else if (r.kind === "both")
      out.push(
        ...(r.order === "localFirst"
          ? [...b.local, ...b.remote]
          : [...b.remote, ...b.local]),
      );
    else if (r.kind === "custom") out.push(...r.lines);
  }
  return out.join("\n");
}

import { diff3Merge } from "node-diff3";

/**
 * Result of running [`magicMerge`] across the parsed conflict set.
 */
export interface MagicMergeResult {
  parsed: ParsedConflicts;
  /** How many blocks were fully auto-resolved on this pass. */
  resolved: number;
  /** How many blocks remain unresolved (need manual attention). */
  unresolved: number;
  /** How many original blocks were *split* into smaller sub-blocks
   *  by the partial-merge strategy. The split blocks themselves
   *  count toward `unresolved` — but each one is now smaller and
   *  more focused than the original. */
  split: number;
  /** Per-strategy tally for the flash banner. */
  byStrategy: Record<MagicStrategy, number>;
}

export type MagicStrategy =
  | "identical"
  | "localUnchanged"
  | "remoteUnchanged"
  | "diff3Clean"
  | "diff3Partial";

/**
 * Walk every unresolved block and try to auto-resolve as much as
 * possible. Strategies, tried in order:
 *
 *   1. **identical** — both sides made the same change → take either.
 *   2. **localUnchanged / remoteUnchanged** — only one side moved
 *      away from base → take the changed side.
 *   3. **diff3Clean** — line-level 3-way merge (Myers + Diff3 via
 *      `node-diff3`) produces a clean, conflict-free result. This
 *      handles the case where LOCAL and REMOTE both changed
 *      *different* lines inside what git marked as one conflict
 *      region. Same algorithmic class as the merge IntelliJ /
 *      VSCode use under "apply non-conflicting changes from both
 *      sides".
 *   4. **diff3Partial** — diff3 returned a *mix* of clean and
 *      conflicting regions. Instead of giving up on the whole
 *      block, we split it: the clean regions become context lines
 *      in the file, and each remaining conflict region becomes a
 *      new (smaller, more focused) conflict block. This is the
 *      IntelliJ "shrink the conflict surface" behaviour. The
 *      result counts toward `split`, and each new sub-block adds
 *      to `unresolved` — but the user now sees small targeted
 *      conflicts instead of one giant unresolved region.
 *
 * Already-resolved blocks pass through untouched.
 */
export function magicMerge(parsed: ParsedConflicts): MagicMergeResult {
  let resolved = 0;
  let unresolved = 0;
  let split = 0;
  const byStrategy: Record<MagicStrategy, number> = {
    identical: 0,
    localUnchanged: 0,
    remoteUnchanged: 0,
    diff3Clean: 0,
    diff3Partial: 0,
  };
  const segments: Segment[] = [];
  let subIdCounter = 0;
  for (const seg of parsed.segments) {
    if (seg.type !== "conflict" || seg.block.resolution !== null) {
      segments.push(seg);
      if (seg.type === "conflict") {
        // resolved block; count it as resolved for accounting.
      }
      continue;
    }
    const b = seg.block;

    // 1. Both sides identical → safest case, no base needed.
    if (linesEqual(b.local, b.remote)) {
      resolved++;
      byStrategy.identical++;
      segments.push({
        type: "conflict",
        block: { ...b, resolution: { kind: "local" } },
      });
      continue;
    }

    if (b.base !== null) {
      // 2. One side unchanged from base → take the other.
      if (linesEqual(b.local, b.base)) {
        resolved++;
        byStrategy.remoteUnchanged++;
        segments.push({
          type: "conflict",
          block: { ...b, resolution: { kind: "remote" } },
        });
        continue;
      }
      if (linesEqual(b.remote, b.base)) {
        resolved++;
        byStrategy.localUnchanged++;
        segments.push({
          type: "conflict",
          block: { ...b, resolution: { kind: "local" } },
        });
        continue;
      }

      // 3 + 4. Line-level 3-way merge.
      const regions = diff3Merge<string>(b.local, b.base, b.remote, {
        excludeFalseConflicts: true,
      });
      const cleanCount = regions.filter((r) => !r.conflict).length;
      const conflictCount = regions.filter((r) => r.conflict).length;

      if (conflictCount === 0) {
        // 3. Fully clean merge.
        const merged: string[] = [];
        for (const region of regions) {
          if (region.ok) merged.push(...region.ok);
        }
        resolved++;
        byStrategy.diff3Clean++;
        segments.push({
          type: "conflict",
          block: {
            ...b,
            resolution: { kind: "custom", lines: merged },
          },
        });
        continue;
      }

      if (cleanCount > 0) {
        // 4. Partial merge — split the block.
        let firstSubblockKept = false;
        for (const region of regions) {
          if (region.ok) {
            // Auto-merged region becomes context.
            appendContext(segments, region.ok);
          } else if (region.conflict) {
            // Still-conflicted region becomes a smaller sub-block.
            const subId = `${b.id}.s${subIdCounter++}`;
            segments.push({
              type: "conflict",
              block: {
                id: subId,
                localLabel: b.localLabel,
                remoteLabel: b.remoteLabel,
                local: region.conflict.a,
                base: region.conflict.o,
                remote: region.conflict.b,
                resolution: null,
              },
            });
            unresolved++;
            firstSubblockKept = true;
          }
        }
        // The original block was "transformed" — count it as split
        // even if every conflict region survived (still useful: each
        // sub-block is smaller than the original).
        if (firstSubblockKept) {
          split++;
          byStrategy.diff3Partial++;
        }
        continue;
      }
    }

    // Couldn't help with this one — leave as-is.
    unresolved++;
    segments.push(seg);
  }

  // `total` counts unresolved + resolved conflict blocks in the
  // returned tree, which may be different from the input's total
  // because of splitting.
  const total = segments.reduce(
    (n, s) => (s.type === "conflict" ? n + 1 : n),
    0,
  );
  return {
    parsed: { segments, total },
    resolved,
    unresolved,
    split,
    byStrategy,
  };
}

/** Append `lines` to the trailing context segment, or start a new
 *  one if the previous segment isn't context. Keeps neighbouring
 *  context runs from fragmenting in `parsed.segments`. */
function appendContext(out: Segment[], lines: string[]): void {
  const last = out[out.length - 1];
  if (last && last.type === "context") {
    out[out.length - 1] = { type: "context", lines: [...last.lines, ...lines] };
  } else {
    out.push({ type: "context", lines: [...lines] });
  }
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function unresolvedCount(parsed: ParsedConflicts): number {
  return parsed.segments.reduce(
    (n, s) =>
      s.type === "conflict" && s.block.resolution === null ? n + 1 : n,
    0,
  );
}

/** Range of lines (1-based, inclusive) occupied by a conflict block
 *  inside a reconstructed side view. */
export interface BlockLineRange {
  blockId: string;
  fromLine: number;
  toLine: number;
}

/** A reconstructed side-view: full text + per-block line ranges. */
export interface SideView {
  /** The full text the user should see in this pane. */
  text: string;
  /** Per-conflict-block line ranges in `text`. */
  ranges: BlockLineRange[];
}

/**
 * Rebuild the LOCAL / REMOTE / BASE side of the file by walking
 * `parsed.segments`, swapping each conflict block's lines for the
 * chosen side. The returned `ranges` give 1-based, inclusive line
 * spans for each block — handy for `Decoration.line` highlighting
 * and for the `<HunkConnector>` ribbons that need pixel-y per
 * block range.
 *
 * For "missing" sides (e.g. `block.base` is `null` because the file
 * wasn't using `merge.conflictStyle = diff3`, or `block.local`/`remote`
 * is empty for an "added by us" / "added by them" case), we emit a
 * single empty line so the block still has a visual position in the
 * pane and the connector ribbon doesn't collapse to a degenerate point.
 */
export function buildSideView(
  parsed: ParsedConflicts,
  side: "local" | "remote" | "base",
): SideView {
  const lines: string[] = [];
  const ranges: BlockLineRange[] = [];
  for (const seg of parsed.segments) {
    if (seg.type === "context") {
      lines.push(...seg.lines);
      continue;
    }
    const b = seg.block;
    let sideLines =
      side === "local" ? b.local : side === "remote" ? b.remote : (b.base ?? []);
    if (sideLines.length === 0) {
      // Keep a phantom line so the range is non-empty. The line
      // body is empty so it visually reads as "this side dropped
      // these lines" once the hunk highlight tints it.
      sideLines = [""];
    }
    const fromLine = lines.length + 1;
    lines.push(...sideLines);
    const toLine = lines.length;
    ranges.push({ blockId: b.id, fromLine, toLine });
  }
  return { text: lines.join("\n"), ranges };
}

/**
 * Map a 1-based line number on one side of the merge to the
 * corresponding 1-based line number on the other side. Used by the
 * merge editor's line-aligned sync scroll.
 *
 *   - **Context lines** (the parts of the file outside any conflict
 *     block) map 1:1 — line N on LOCAL is line N on REMOTE within
 *     a context segment.
 *   - **Conflict-block lines** map proportionally inside the block.
 *     If a hunk is 10 lines on LOCAL and 4 lines on REMOTE, line 5
 *     of 10 maps to line 2 of 4.
 *
 * `fromRanges` and `toRanges` must be in matching order (they come
 * from `buildSideView` over the same `parsed.segments`, which
 * guarantees this).
 */
export function mapLineBetweenSides(
  fromRanges: BlockLineRange[],
  toRanges: BlockLineRange[],
  fromLine: number,
): number {
  // Walk parallel through the ranges. At each step, the gap between
  // the previous block's end and the next block's start is context
  // (same length on both sides). Inside a block, lines map
  // proportionally.
  let fromCursor = 1;
  let toCursor = 1;
  const n = Math.min(fromRanges.length, toRanges.length);
  for (let i = 0; i < n; i++) {
    const fr = fromRanges[i];
    const tr = toRanges[i];
    const contextLen = fr.fromLine - fromCursor;
    if (fromLine < fromCursor + contextLen) {
      return toCursor + (fromLine - fromCursor);
    }
    fromCursor += contextLen;
    toCursor += contextLen;
    const fromBlockLen = fr.toLine - fr.fromLine + 1;
    const toBlockLen = tr.toLine - tr.fromLine + 1;
    if (fromLine <= fr.toLine) {
      const offset = fromLine - fr.fromLine;
      const ratio = fromBlockLen <= 1 ? 0 : offset / (fromBlockLen - 1);
      return tr.fromLine + Math.round(ratio * (toBlockLen - 1));
    }
    fromCursor = fr.toLine + 1;
    toCursor = tr.toLine + 1;
  }
  // Trailing context past the last block: 1:1.
  return toCursor + (fromLine - fromCursor);
}

/**
 * Build the editable RESULT text from `parsed`, tracking which line
 * ranges still hold unresolved conflict markers (so the merge editor
 * can paint those amber). Resolved blocks emit just their chosen
 * lines and contribute no range.
 */
export function buildResultView(parsed: ParsedConflicts): SideView {
  const lines: string[] = [];
  const ranges: BlockLineRange[] = [];
  for (const seg of parsed.segments) {
    if (seg.type === "context") {
      lines.push(...seg.lines);
      continue;
    }
    const b = seg.block;
    const r = b.resolution;
    if (r === null) {
      const fromLine = lines.length + 1;
      lines.push(`<<<<<<< ${b.localLabel}`);
      lines.push(...b.local);
      if (b.base) {
        lines.push(`||||||| ${b.localLabel}`);
        lines.push(...b.base);
      }
      lines.push("=======");
      lines.push(...b.remote);
      lines.push(`>>>>>>> ${b.remoteLabel}`);
      const toLine = lines.length;
      ranges.push({ blockId: b.id, fromLine, toLine });
      continue;
    }
    if (r.kind === "local") lines.push(...b.local);
    else if (r.kind === "remote") lines.push(...b.remote);
    else if (r.kind === "base") lines.push(...(b.base ?? []));
    else if (r.kind === "both")
      lines.push(
        ...(r.order === "localFirst"
          ? [...b.local, ...b.remote]
          : [...b.remote, ...b.local]),
      );
    else if (r.kind === "custom") lines.push(...r.lines);
  }
  return { text: lines.join("\n"), ranges };
}
