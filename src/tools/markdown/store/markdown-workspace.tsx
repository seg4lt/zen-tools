/**
 * Markdown split-workspace state — hoisted out of `<MarkdownView>`
 * so the layout (split tree + per-leaf tab assignment + focused
 * leaf) survives tool-tab navigation.
 *
 * Without this, every navigation to /markdown re-mounted MarkdownView,
 * which re-ran `useSplitWorkspace()` and `useState({})` for `leafTabs`
 * — collapsing whatever splits the user had opened back to the
 * default single-leaf layout. The MarkdownStoreProvider already lives
 * at `<AppProviders>` (so file tabs / vault list / dirty docs all
 * survive); the split layout was the missing companion piece.
 *
 * Provider is rendered INSIDE MarkdownStoreProvider in this same
 * file's `MarkdownStoreProvider` wrapper — workspace state is
 * markdown-specific, doesn't need to be exposed at the app shell
 * level, and benefits from sitting next to the store it complements.
 *
 * What does NOT live here (intentionally local to MarkdownView):
 *   - `leafHandlesRef` (map of leaf id → CodeMirror handle):
 *     CodeMirror instances are owned by their host component; a
 *     re-mount has to rebuild them anyway because the underlying
 *     `<MarkdownEditor>`s are fresh React subtrees. Hoisting the
 *     ref here would make us hold stale handles after a remount.
 *   - `prevFocusedLeafRef`: belongs to the focus-sync effect
 *     (effect A in MarkdownView). It's a render-time bookkeeping
 *     ref, not durable state.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useSplitWorkspace, type SplitWorkspaceApi } from "@zen-tools/editor";

interface MarkdownWorkspaceValue {
  /** Split-tree state machine — see `@zen-tools/editor::useSplitWorkspace`. */
  workspace: SplitWorkspaceApi;
  /**
   * Per-leaf tab id assignment. Keyed by `SplitWorkspaceApi`'s leaf
   * ids; values are tab ids from the markdown store's `state.tabs`.
   * Stale entries (closed leaves / closed tabs) are pruned by an
   * effect inside MarkdownView.
   */
  leafTabs: Record<string, string>;
  /** Setter — used by the same MarkdownView effects that own the pruning. */
  setLeafTabs: Dispatch<SetStateAction<Record<string, string>>>;
}

const WorkspaceCtx = createContext<MarkdownWorkspaceValue | null>(null);

export function MarkdownWorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useSplitWorkspace();
  const [leafTabs, setLeafTabs] = useState<Record<string, string>>({});

  // Memoise so consumers using object-equality of the context value
  // don't re-render on unrelated parent re-renders. The inner
  // workspace API + leafTabs are themselves stable / change-tracked.
  const value = useMemo<MarkdownWorkspaceValue>(
    () => ({ workspace, leafTabs, setLeafTabs }),
    [workspace, leafTabs],
  );

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

/** Access the persistent split workspace + per-leaf tab assignment. */
export function useMarkdownWorkspace(): MarkdownWorkspaceValue {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) {
    throw new Error(
      "useMarkdownWorkspace must be used inside <MarkdownWorkspaceProvider>",
    );
  }
  return ctx;
}
