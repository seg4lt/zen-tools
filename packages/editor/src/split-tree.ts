/**
 * Split tree — pure data model for nested vim-style editor splits.
 *
 * The tree is a binary tree of `Leaf | Branch`. Each leaf carries a
 * stable string id; the host (e.g. a tool's reducer) decides what
 * the id maps to (a tab id, a request id, etc.). Branches carry a
 * direction (`vertical` = side-by-side / `:vsplit`; `horizontal` =
 * stacked / `:split`) and a `ratio` in (0, 1) — the fraction of the
 * branch's size taken by `first`.
 *
 * `path` strings used by the resize helper are sequences of `0`/`1`
 * characters describing the descent from the root: `0` = into
 * `first`, `1` = into `second`. The empty string identifies the
 * root branch.
 */

export type SplitDirection = "horizontal" | "vertical";

export type SplitNode =
  | { kind: "leaf"; id: string }
  | {
      kind: "branch";
      direction: SplitDirection;
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

/** Direction codes used by `Ctrl+W h/j/k/l`. */
export type MoveDirection = "h" | "j" | "k" | "l";

/** A tree consisting of a single leaf with the given id. */
export function makeRoot(id: string): SplitNode {
  return { kind: "leaf", id };
}

/** Every leaf id present in the tree, in left-to-right / top-to-bottom order. */
export function leafIds(tree: SplitNode): string[] {
  if (tree.kind === "leaf") return [tree.id];
  return [...leafIds(tree.first), ...leafIds(tree.second)];
}

/** Number of leaves in the tree. */
export function leafCount(tree: SplitNode): number {
  if (tree.kind === "leaf") return 1;
  return leafCount(tree.first) + leafCount(tree.second);
}

/** Whether `id` is a leaf somewhere in the tree. */
export function hasLeaf(tree: SplitNode, id: string): boolean {
  if (tree.kind === "leaf") return tree.id === id;
  return hasLeaf(tree.first, id) || hasLeaf(tree.second, id);
}

/**
 * Replace the leaf with id `leafId` with a new branch. The original
 * leaf becomes `first`; a fresh leaf with id `newLeafId` becomes
 * `second`. If the leaf isn't found the tree is returned unchanged.
 */
export function splitLeaf(
  tree: SplitNode,
  leafId: string,
  newLeafId: string,
  direction: SplitDirection,
): SplitNode {
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    return {
      kind: "branch",
      direction,
      ratio: 0.5,
      first: { kind: "leaf", id: leafId },
      second: { kind: "leaf", id: newLeafId },
    };
  }
  return {
    ...tree,
    first: splitLeaf(tree.first, leafId, newLeafId, direction),
    second: splitLeaf(tree.second, leafId, newLeafId, direction),
  };
}

/**
 * Remove the leaf with id `leafId`. The sibling absorbs the freed
 * space (the parent branch is replaced by the surviving sibling).
 *
 * Returns `null` when the closed leaf was the only leaf in the tree
 * — callers should guard against this where they don't want to lose
 * the workspace altogether (vim's `:q` on the last window quits
 * vim).
 */
export function closeLeaf(tree: SplitNode, leafId: string): SplitNode | null {
  if (tree.kind === "leaf") {
    return tree.id === leafId ? null : tree;
  }
  const newFirst = closeLeaf(tree.first, leafId);
  if (newFirst === null) return tree.second;
  const newSecond = closeLeaf(tree.second, leafId);
  if (newSecond === null) return tree.first;
  return { ...tree, first: newFirst, second: newSecond };
}

/**
 * Update the `ratio` of the branch identified by `path`. No-op when
 * the path doesn't lead to a branch. `ratio` is clamped to
 * `[0.05, 0.95]` so a pane can't be fully collapsed.
 */
export function resizeBranch(
  tree: SplitNode,
  path: string,
  ratio: number,
): SplitNode {
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  if (path === "") {
    if (tree.kind !== "branch") return tree;
    return { ...tree, ratio: clamped };
  }
  if (tree.kind !== "branch") return tree;
  const [head, ...rest] = path;
  const restPath = rest.join("");
  if (head === "0") {
    return { ...tree, first: resizeBranch(tree.first, restPath, clamped) };
  }
  return { ...tree, second: resizeBranch(tree.second, restPath, clamped) };
}

interface PathStep {
  branch: Extract<SplitNode, { kind: "branch" }>;
  /** Which side of `branch` we descended into. */
  from: "first" | "second";
}

function pathTo(tree: SplitNode, leafId: string): PathStep[] | null {
  if (tree.kind === "leaf") {
    return tree.id === leafId ? [] : null;
  }
  const left = pathTo(tree.first, leafId);
  if (left) return [{ branch: tree, from: "first" }, ...left];
  const right = pathTo(tree.second, leafId);
  if (right) return [{ branch: tree, from: "second" }, ...right];
  return null;
}

/** Walk to the nearest leaf in `tree`, always descending into `first`. */
function descendFirstLeaf(tree: SplitNode): string {
  while (tree.kind === "branch") tree = tree.first;
  return tree.id;
}

/** Walk to the deepest "second" leaf (rightmost / bottommost). */
function descendLastLeaf(tree: SplitNode): string {
  while (tree.kind === "branch") tree = tree.second;
  return tree.id;
}

/**
 * Find the leaf adjacent to `leafId` in vim direction `dir`, or
 * `null` if there's nothing in that direction (we're already at the
 * outer edge).
 *
 * Algorithm: walk up the tree until we hit a branch whose direction
 * matches the requested axis (vertical = `h`/`l`, horizontal =
 * `j`/`k`) AND whose subtree we entered from the side we want to
 * leave. Then descend the opposite subtree, picking the leaf nearest
 * the source.
 */
export function adjacentLeaf(
  tree: SplitNode,
  leafId: string,
  dir: MoveDirection,
): string | null {
  const path = pathTo(tree, leafId);
  if (!path) return null;

  const wantedAxis: SplitDirection =
    dir === "h" || dir === "l" ? "vertical" : "horizontal";
  // We want to leave whichever side of the matching branch the
  // target leaf currently sits on:
  //   - h (move left)  → leaf is on `second`, descend `first`'s rightmost
  //   - l (move right) → leaf is on `first`,  descend `second`'s leftmost
  //   - k (move up)    → leaf is on `second`, descend `first`'s bottom
  //   - j (move down)  → leaf is on `first`,  descend `second`'s top
  const fromSide: "first" | "second" =
    dir === "h" || dir === "k" ? "second" : "first";

  for (let i = path.length - 1; i >= 0; i--) {
    const step = path[i];
    if (step.branch.direction !== wantedAxis) continue;
    if (step.from !== fromSide) continue;
    const target =
      fromSide === "first" ? step.branch.second : step.branch.first;
    // Pick the closest leaf to where we came from.
    return fromSide === "first"
      ? descendFirstLeaf(target)
      : descendLastLeaf(target);
  }
  return null;
}
