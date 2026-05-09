/**
 * Pure lane-assignment for the commit log's IntelliJ-style graph column.
 *
 * Single top-to-bottom pass over the loaded commit window. The order
 * matches what the UI displays: newest commits first, parents below.
 * Maintains a working `lanes` array where `lanes[i] = sha` means "lane
 * `i` is currently waiting for `sha` to be drawn — one of its
 * descendants linked to it as a parent".
 *
 * For each commit `C` at row `r`:
 *
 *   1. Find the leftmost lane already waiting for `C.hash`. If there
 *      isn't one (C has no in-window descendants — typical for branch
 *      tips, the first row, and re-opened branches) take the leftmost
 *      free slot, or append a new lane.
 *   2. Any *other* lane also waiting for `C.hash` is recorded as an
 *      incoming arc from row `r-1` into the chosen lane, then cleared.
 *   3. Every lane still holding a non-null sha that isn't `C.hash`
 *      passes straight through this row.
 *   4. C's lane is replaced with `C.parents[0]` (or cleared if C is a
 *      root commit).
 *   5. Each additional parent (merges, octopus merges) is parked in a
 *      free slot to the right and recorded as an outgoing arc.
 *
 * Output is two pieces: per-row geometry (`RowGraph[]`) and the maximum
 * lane count seen across the window. The caller uses `maxLanes` to size
 * the graph column once for the whole list, so rows don't jitter
 * horizontally as the user scrolls.
 *
 * Complexity: O(n × max_lanes) with `max_lanes` typically < 10. Trivial
 * for the few-thousand-row windows the log shows.
 */

import type { Commit } from "../../lib/tauri";

/**
 * Lane palette — rotated by lane index. Tailwind 500-shade hues chosen
 * to read on both light and dark backgrounds; ordered for adjacent
 * contrast so neighbouring lanes don't blur together. We deliberately
 * use literal hex values (not Tailwind class names) because the SVG
 * `stroke` / `fill` attributes can't consume class-based colors and the
 * graph stays legible on every theme. Keep the list prime-ish in length
 * so the modulo cycle doesn't collide visually with common merge
 * patterns.
 */
export const GRAPH_LANE_COLORS = [
  "#10b981", // emerald
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#f43f5e", // rose
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#d946ef", // fuchsia
] as const;

/** Geometry for a single row's slice of the graph column. */
export interface RowGraph {
  /** Column index where the commit's node circle sits. 0-based. */
  nodeLane: number;
  /** Stroke / fill color for `nodeLane`. */
  nodeColor: string;
  /** `commit.parents.length > 1`. Drives the merge-node styling. */
  isMerge: boolean;
  /** `commit.parents.length === 0`. Drives the root-node styling. */
  isRoot: boolean;
  /**
   * Lanes (other than `nodeLane`) that go straight through this row,
   * top-to-bottom. Each entry is paired with `passColors[i]` so the
   * renderer doesn't need to recompute the palette index.
   */
  passes: number[];
  passColors: string[];
  /**
   * Lanes from the row *above* that bend inwards and terminate at this
   * commit's node — i.e. ancestor convergence into the merge node, plus
   * a short connector when a commit's lane shifts left to fill a gap.
   * Colors come from each source lane (the lane the arc *leaves* from).
   */
  incomingArcs: Array<{ fromLane: number; color: string }>;
  /**
   * `true` iff the commit's lane was already alive (carrying its sha)
   * before this row — i.e. some descendant in the loaded window listed
   * this commit as a parent. Drives the "top stub" stroke above the
   * node: when this is `true`, the stub is drawn (lane continues from
   * above into the node); when `false`, the row is the start of a
   * fresh branch tip and no stub is drawn (IntelliJ convention — the
   * node *is* the branch's starting point).
   */
  nodeLanePreexisted: boolean;
  /**
   * Lanes this row *births* — typically the second+ parents of a merge
   * commit, parked to the right. Colors come from the destination lane
   * (which is brand-new for that side branch).
   */
  outgoingArcs: Array<{ toLane: number; color: string }>;
  /** Max lane index in use as of this row + 1. Useful for diagnostics. */
  laneCount: number;
}

export interface GraphLayout {
  rows: RowGraph[];
  /** Widest the graph gets across the entire window. Use this — not the
   *  per-row `laneCount` — to pick the column width so the content
   *  offset stays constant as the user scrolls. */
  maxLanes: number;
}

/** Pick the leftmost slot in `lanes` that is `null`. Returns `lanes.length`
 *  if every slot is occupied (caller appends a new lane). */
function firstFreeLane(lanes: Array<string | null>): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null) return i;
  }
  return lanes.length;
}

/** Pick the leftmost slot waiting for `sha`. Returns `-1` if none. */
function findLane(lanes: Array<string | null>, sha: string): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === sha) return i;
  }
  return -1;
}

/**
 * Walk the commit window and produce per-row graph geometry. Pure —
 * deterministic over input, no side effects.
 */
export function computeGraphLayout(commits: Commit[]): GraphLayout {
  const rows: RowGraph[] = [];
  let maxLanes = 0;
  // `lanes[i]` is the sha the lane is currently waiting for, or `null`
  // if the lane is dormant. Length grows as new lanes are needed and
  // never shrinks within a window — rows always render against the
  // same horizontal grid even if early lanes go dormant.
  const lanes: Array<string | null> = [];

  for (const commit of commits) {
    // ── 1. Find or open this commit's lane ─────────────────────────
    let nodeLane = findLane(lanes, commit.hash);
    // Track whether the lane existed *before* we touched it. Used by
    // the renderer to decide if a "top stub" should be drawn above
    // the node (lane continued from above) or not (branch tip).
    const nodeLanePreexisted = nodeLane !== -1;
    if (nodeLane === -1) {
      // No descendant in the window claimed this commit yet — take a
      // fresh lane (reusing a dormant slot if one exists).
      nodeLane = firstFreeLane(lanes);
      if (nodeLane === lanes.length) lanes.push(null);
    }

    // ── 2. Collect incoming arcs from any *other* lane waiting for C ─
    const incomingArcs: RowGraph["incomingArcs"] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i === nodeLane) continue;
      if (lanes[i] === commit.hash) {
        incomingArcs.push({
          fromLane: i,
          color: GRAPH_LANE_COLORS[i % GRAPH_LANE_COLORS.length],
        });
        // Clear the lane — the arc has terminated; the slot is
        // available for any later commit's spawned parent.
        lanes[i] = null;
      }
    }

    // ── 3. Collect pass-through lanes ──────────────────────────────
    // A lane passes through if it's still waiting for *another* sha
    // (not C) at this point. We've already cleared the incoming arcs
    // above so the remaining non-null slots are the genuine passes.
    const passes: number[] = [];
    const passColors: string[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i === nodeLane) continue;
      if (lanes[i] !== null) {
        passes.push(i);
        passColors.push(GRAPH_LANE_COLORS[i % GRAPH_LANE_COLORS.length]);
      }
    }

    // ── 4. Replace C's lane with first parent (or clear for root) ──
    const firstParent = commit.parents[0] ?? null;
    lanes[nodeLane] = firstParent;

    // ── 5. Spawn lanes for the remaining parents (merges) ──────────
    const outgoingArcs: RowGraph["outgoingArcs"] = [];
    for (let p = 1; p < commit.parents.length; p++) {
      let slot = firstFreeLane(lanes);
      if (slot === lanes.length) lanes.push(null);
      lanes[slot] = commit.parents[p];
      outgoingArcs.push({
        toLane: slot,
        color: GRAPH_LANE_COLORS[slot % GRAPH_LANE_COLORS.length],
      });
    }

    const laneCount = lanes.length;
    if (laneCount > maxLanes) maxLanes = laneCount;

    rows.push({
      nodeLane,
      nodeColor: GRAPH_LANE_COLORS[nodeLane % GRAPH_LANE_COLORS.length],
      isMerge: commit.parents.length > 1,
      isRoot: commit.parents.length === 0,
      passes,
      passColors,
      incomingArcs,
      outgoingArcs,
      laneCount,
      nodeLanePreexisted,
    });
  }

  // Empty input → at least 1-wide so the column doesn't collapse to 0.
  if (maxLanes === 0) maxLanes = 1;
  return { rows, maxLanes };
}
