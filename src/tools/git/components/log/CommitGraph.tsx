/**
 * Per-row SVG slice of the commit log's graph column.
 *
 * Renders four kinds of geometry inside a 28px-tall, `maxLanes * pitch`
 * wide canvas:
 *
 *   - Pass-through verticals — straight strokes for every lane that
 *     isn't this commit's lane but is still alive at this row.
 *   - Incoming arcs — quadratic Béziers from a sibling lane at the row
 *     top down to this commit's node centre. Used when ancestor lanes
 *     converge into a merge or when a lane shifts left to fill a gap.
 *   - Outgoing arcs — quadratic Béziers from this commit's node centre
 *     down to a freshly-opened lane. Each extra parent of a merge gets
 *     one.
 *   - Node — a filled circle for normal commits, a thicker-stroked
 *     hollow circle for merges, a small outlined dot for root commits.
 *
 * The component takes its `RowGraph` plus the workspace-wide `maxLanes`
 * and `pitch`; it renders the same canvas width on every row so the
 * subject column starts at a constant x-offset and the virtualizer
 * doesn't have to deal with variable row geometry.
 *
 * Pure presentational — receives everything it needs as props, has no
 * state, no effects, no hooks. Safe to render inside the virtualizer
 * with no memoisation overhead.
 */

import type { RowGraph } from "./graph-layout";

export interface CommitGraphProps {
  row: RowGraph;
  /** Window-wide max lane count from `GraphLayout.maxLanes`. Drives the
   *  SVG width so every row paints against the same horizontal grid. */
  maxLanes: number;
  /** Horizontal distance between adjacent lane centres, px. */
  pitch?: number;
  /** Row height, px. Must match the parent `<CommitRow>`'s height
   *  (28 today) so vertical strokes and arc termination y-coords line
   *  up edge-to-edge across consecutive rows. */
  height?: number;
}

const DEFAULT_PITCH = 14;
const DEFAULT_HEIGHT = 28;
const NODE_RADIUS = 4;
const STROKE_WIDTH = 1.5;

/** Lane index → x-coordinate (centre of the lane). */
function laneX(lane: number, pitch: number): number {
  // Half-pitch padding on the left so lane 0 isn't flush against the
  // SVG edge — keeps the leftmost stroke from getting clipped by 0.5px
  // on browsers that don't half-pixel-align stroke geometry.
  return pitch / 2 + lane * pitch;
}

export function CommitGraph({
  row,
  maxLanes,
  pitch = DEFAULT_PITCH,
  height = DEFAULT_HEIGHT,
}: CommitGraphProps) {
  const width = maxLanes * pitch;
  const midY = height / 2;
  const nodeX = laneX(row.nodeLane, pitch);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      aria-hidden
    >
      {/* Pass-through verticals — straight from top edge to bottom. */}
      {row.passes.map((lane, i) => {
        const x = laneX(lane, pitch);
        return (
          <line
            key={`pass-${lane}`}
            x1={x}
            y1={0}
            x2={x}
            y2={height}
            stroke={row.passColors[i]}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
        );
      })}

      {/* Incoming arcs — sibling lanes converging into the node from
          above. Quadratic Bézier with a control point at (nodeX, 0)
          gives a clean, IntelliJ-like elbow that lands on the node
          centre without overshooting. */}
      {row.incomingArcs.map(({ fromLane, color }) => {
        const fromX = laneX(fromLane, pitch);
        return (
          <path
            key={`in-${fromLane}`}
            d={`M ${fromX} 0 Q ${fromX} ${midY} ${nodeX} ${midY}`}
            fill="none"
            stroke={color}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
        );
      })}

      {/* Outgoing arcs — extra parents of a merge spawn a new lane to
          the right. Mirror geometry of the incoming arc: control point
          at the destination lane's x and the row midpoint, so the
          arc leaves the node, bends sideways, then drops vertically
          off the bottom edge to meet the new lane on the next row. */}
      {row.outgoingArcs.map(({ toLane, color }) => {
        const toX = laneX(toLane, pitch);
        return (
          <path
            key={`out-${toLane}`}
            d={`M ${nodeX} ${midY} Q ${toX} ${midY} ${toX} ${height}`}
            fill="none"
            stroke={color}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
        );
      })}

      {/* Vertical stub from this row's node down to the next row in
          the node's own lane — i.e. C → first parent. Skipped for root
          commits (no parent below) so the lane visually terminates. */}
      {!row.isRoot && (
        <line
          x1={nodeX}
          y1={midY}
          x2={nodeX}
          y2={height}
          stroke={row.nodeColor}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
        />
      )}

      {/* Top stub — vertical from the top edge into the node centre.
          Only drawn when the node's lane *preexisted* above this row
          (a descendant pointed at this commit as a parent). Branch
          tips get no stub: the node IS the start of the lane, so a
          phantom stroke above it would read like an orphan thread. */}
      {row.nodeLanePreexisted && (
        <line
          x1={nodeX}
          y1={0}
          x2={nodeX}
          y2={midY}
          stroke={row.nodeColor}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
        />
      )}

      {/* Node circle. Three styles:
          - merge:   hollow stroked circle (so the converging arcs read
                     into the centre rather than disappearing under a
                     filled disc).
          - root:    filled small disc with a thin outline so it reads
                     as a terminator.
          - normal:  filled disc, palette-coloured.   */}
      <circle
        cx={nodeX}
        cy={midY}
        r={NODE_RADIUS}
        fill={row.isMerge ? "var(--background, #fff)" : row.nodeColor}
        stroke={row.nodeColor}
        strokeWidth={row.isMerge ? 2 : 1}
      />
      {row.isRoot && (
        <circle
          cx={nodeX}
          cy={midY}
          r={NODE_RADIUS - 2}
          fill="var(--background, #fff)"
        />
      )}
    </svg>
  );
}
