/**
 * `useSplitWorkspace` — manages the split-tree state for one tool.
 *
 * Returns a stable API with the current tree, focused leaf id, and
 * actions for splitting / closing / moving / resizing. Each tool's
 * top-level view calls this hook once and threads the result into
 * `<SplitLayout>` plus the editor's `onMoveFocus` callback.
 *
 * The hook deliberately doesn't know anything tool-specific (no
 * tabs, no buffer state) — `closeFocused()` only closes a *split*.
 * "Close the active tab" semantics live in the tool's
 * `WorkspaceContext.closeActive` callback, which can fall back to
 * tab-close when `leafCount === 1`.
 */

import { useCallback, useMemo, useReducer } from "react";
import {
  type MoveDirection,
  type SplitDirection,
  type SplitNode,
  adjacentLeaf,
  closeLeaf,
  leafCount as countLeaves,
  leafIds,
  makeRoot,
  resizeBranch,
  splitLeaf,
} from "./split-tree";

export interface SplitWorkspaceApi {
  /** Current split tree. */
  tree: SplitNode;
  /** Id of the leaf that currently owns input focus. */
  focusedLeafId: string;
  /** Convenience — `leafCount(tree)`. Re-derived on every render. */
  leafCount: number;
  /** Force the focused leaf to a specific id. No-op for unknown ids. */
  setFocus: (leafId: string) => void;
  /** Split the focused leaf. The new leaf becomes focused, mirroring vim. */
  split: (direction: SplitDirection) => void;
  /**
   * Close the focused split. Returns `true` if a leaf was actually
   * removed; `false` when only one leaf remains (caller should fall
   * back to "close the active tab" if appropriate).
   */
  closeFocused: () => boolean;
  /** Move focus in vim direction. Edge moves are silent no-ops. */
  moveFocus: (dir: MoveDirection) => void;
  /** Update a branch's split ratio. */
  resize: (branchPath: string, ratio: number) => void;
}

interface SplitState {
  tree: SplitNode;
  focusedLeafId: string;
  /** Monotonic counter so split-generated leaf ids never collide. */
  nextLeafSeq: number;
}

type Action =
  | { type: "setFocus"; leafId: string }
  | { type: "split"; direction: SplitDirection }
  | { type: "closeFocused" }
  | { type: "moveFocus"; dir: MoveDirection }
  | { type: "resize"; path: string; ratio: number };

function reducer(state: SplitState, action: Action): SplitState {
  switch (action.type) {
    case "setFocus": {
      if (state.focusedLeafId === action.leafId) return state;
      // Quick membership check — we don't allow focusing a leaf that
      // isn't part of the tree.
      if (!leafIds(state.tree).includes(action.leafId)) return state;
      return { ...state, focusedLeafId: action.leafId };
    }
    case "split": {
      const newLeafId = `leaf-${state.nextLeafSeq}`;
      const tree = splitLeaf(
        state.tree,
        state.focusedLeafId,
        newLeafId,
        action.direction,
      );
      return {
        tree,
        focusedLeafId: newLeafId,
        nextLeafSeq: state.nextLeafSeq + 1,
      };
    }
    case "closeFocused": {
      if (countLeaves(state.tree) <= 1) return state;
      const next = closeLeaf(state.tree, state.focusedLeafId);
      if (!next) return state;
      // Focus moves to the first surviving leaf — vim picks the
      // sibling that absorbed the space, but "first leaf" is good
      // enough for v1 (the user can `Ctrl+W`-navigate from there).
      const survivors = leafIds(next);
      return {
        ...state,
        tree: next,
        focusedLeafId: survivors[0] ?? state.focusedLeafId,
      };
    }
    case "moveFocus": {
      const target = adjacentLeaf(
        state.tree,
        state.focusedLeafId,
        action.dir,
      );
      if (!target || target === state.focusedLeafId) return state;
      return { ...state, focusedLeafId: target };
    }
    case "resize": {
      const tree = resizeBranch(state.tree, action.path, action.ratio);
      return tree === state.tree ? state : { ...state, tree };
    }
  }
}

export function useSplitWorkspace(): SplitWorkspaceApi {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    tree: makeRoot("leaf-0"),
    focusedLeafId: "leaf-0",
    nextLeafSeq: 1,
  }));

  const setFocus = useCallback((leafId: string) => {
    dispatch({ type: "setFocus", leafId });
  }, []);
  const split = useCallback((direction: SplitDirection) => {
    dispatch({ type: "split", direction });
  }, []);
  const closeFocused = useCallback((): boolean => {
    // The reducer no-ops when there's only one leaf. We return that
    // information to the caller without needing a side-channel: read
    // the leaf count from the *current* state at call time. Since
    // dispatch is synchronous in event handlers (React 18), the
    // `leafCount` we close against here is consistent with the close
    // attempt the reducer just received.
    const before = countLeaves(state.tree);
    dispatch({ type: "closeFocused" });
    return before > 1;
  }, [state.tree]);
  const moveFocus = useCallback((dir: MoveDirection) => {
    dispatch({ type: "moveFocus", dir });
  }, []);
  const resize = useCallback((path: string, ratio: number) => {
    dispatch({ type: "resize", path, ratio });
  }, []);

  // Memoise the API container so child components that depend on the
  // whole object don't re-render on unrelated state churn. The tree
  // and focus id are inlined so consumers can `useEffect([api.tree])`
  // without false positives.
  const leafCount = useMemo(() => countLeaves(state.tree), [state.tree]);
  return useMemo<SplitWorkspaceApi>(
    () => ({
      tree: state.tree,
      focusedLeafId: state.focusedLeafId,
      leafCount,
      setFocus,
      split,
      closeFocused,
      moveFocus,
      resize,
    }),
    [
      state.tree,
      state.focusedLeafId,
      leafCount,
      setFocus,
      split,
      closeFocused,
      moveFocus,
      resize,
    ],
  );
}
