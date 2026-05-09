/**
 * Top-level shell for the **Git** tool.
 *
 *   ┌─── RepoSidebar ───┬─── Tabs: Log | Merge ────────────────────────┐
 *   │                   │                                              │
 *   │  • repo A         │   active tab pane                            │
 *   │  • repo B         │                                              │
 *   │                   │                                              │
 *   └───────────────────┴──────────────────────────────────────────────┘
 *
 * Layout primitives:
 *   - The sidebar collapses to a 40 px icon strip via the chevron in its
 *     header (`localStorage["git.sidebar.collapsed"]`).
 *   - The boundary between sidebar and main is a drag-resizable
 *     `<Split>` (size persisted under `git.split:shell.sidebar`).
 *   - Both `<CommitLogPane>` and `<MergePane>` are *always* mounted —
 *     hidden via CSS when their tab isn't active. That preserves
 *     scroll positions, loaded blobs, and the RESULT-pane buffer
 *     across tab switches.
 *   - Focus mode overlays the merge editor on top of everything via
 *     `position: fixed; inset: 0; z-50`. Crucially, the React-tree
 *     position of `<MergePane>` does NOT change between modes, so no
 *     remount happens and all merge state survives the toggle.
 */

import { useEffect, useMemo, useState } from "react";
import { GitBranch, GitMerge, History } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@zen-tools/ui";

import { useTheme } from "@/hooks/use-theme";

import { CommitLogPane } from "./components/log/CommitLogPane";
import { MergePane } from "./components/merge/MergePane";
import { RepoSidebar } from "./components/RepoSidebar";
import { Split } from "./components/shared/Split";
import { gitTauri } from "./lib/tauri";
import { GitStoreProvider, useGitStore } from "./store/git-store";

const COLLAPSE_KEY = "git.sidebar.collapsed";

export type GitInitialTab = "log" | "merge";

export interface GitShellProps {
  initialTab?: GitInitialTab;
}

export function GitShell(props: GitShellProps) {
  return (
    <GitStoreProvider>
      <GitShellInner {...props} />
    </GitStoreProvider>
  );
}

function GitShellInner({ initialTab = "log" }: GitShellProps) {
  const { state, dispatch } = useGitStore();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [focusMode, setFocusMode] = useState(false);
  const [activeTab, setActiveTab] = useState<GitInitialTab>(initialTab);

  const toggleCollapsed = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  // Poll merge state for the active repo so the Merge-tab pill can
  // show a badge when conflicts exist.
  useEffect(() => {
    if (!state.activeRepoPath) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const ms = await gitTauri.mergeState(state.activeRepoPath!);
        if (!cancelled) dispatch({ type: "set-merge-state", state: ms });
      } catch {
        /* ignore — surfaces inside Merge tab */
      }
    };
    void tick();
    timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [state.activeRepoPath, dispatch]);

  const mergeBadge = useMemo(() => {
    const ms = state.mergeState;
    if (!ms || ms.kind === "none") return null;
    return ms.unresolved > 0 ? `${ms.unresolved}` : "✓";
  }, [state.mergeState]);

  // ── Empty state ────────────────────────────────────────────────────
  if (!state.activeRepoPath) {
    return (
      <div className="flex h-full w-full min-h-0">
        <RepoSidebar
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
          <div>
            <GitBranch className="mx-auto mb-3 h-6 w-6 opacity-60" />
            <p>Add a repository from the sidebar to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main layout ───────────────────────────────────────────────────
  // Both tab contents are `forceMount`ed so their inner state survives
  // tab switches. Visibility is driven by Radix's `data-state`
  // attribute via the `data-[state=inactive]:hidden` utility.
  const main = (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as GitInitialTab)}
      className="flex h-full min-h-0 flex-col"
    >
      {/* Tab strip is hidden in focus mode but stays mounted. */}
      <TabsList
        className={cn("mx-3 mt-2 self-start", focusMode && "hidden")}
      >
        <TabsTrigger value="log" className="gap-1.5">
          <History className="h-3.5 w-3.5" /> Log
        </TabsTrigger>
        <TabsTrigger value="merge" className="gap-1.5">
          <GitMerge className="h-3.5 w-3.5" /> Merge
          {mergeBadge && (
            <span
              className={cn(
                "ml-1 rounded px-1 py-0.5 text-[9px] font-mono",
                mergeBadge === "✓"
                  ? "bg-emerald-500/20 text-emerald-600"
                  : "bg-amber-500/20 text-amber-600",
              )}
            >
              {mergeBadge}
            </span>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="log"
        forceMount
        className={cn(
          "flex-1 min-h-0 min-w-0 outline-none",
          // Hide log when not active OR when in focus mode (focus =
          // merge takes over).
          (activeTab !== "log" || focusMode) && "hidden",
        )}
      >
        <CommitLogPane repo={state.activeRepoPath} isDark={isDark} />
      </TabsContent>

      {/* Merge content is `forceMount`ed AND, when focus mode is on,
          its wrapper escapes the layout via `fixed inset-0 z-50`.
          The MergePane component itself never moves in the React
          tree, so no remount happens on focus toggle. */}
      <TabsContent
        value="merge"
        forceMount
        className={cn(
          "outline-none",
          focusMode
            ? "fixed inset-0 z-50 bg-background"
            : cn("flex-1 min-h-0 min-w-0", activeTab !== "merge" && "hidden"),
        )}
      >
        <MergePane
          repo={state.activeRepoPath}
          isDark={isDark}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((v) => !v)}
        />
      </TabsContent>
    </Tabs>
  );

  // In focus mode the sidebar is hidden (the merge overlay covers
  // everything anyway), but we still render it to keep its tree
  // position stable.
  return (
    <Split
      direction="horizontal"
      // Distinct keys per mode so collapsing snaps to 40 px without
      // wiping the user's preferred expanded width.
      storageKey={collapsed ? "shell.sidebar.collapsed" : "shell.sidebar"}
      defaultFirst={collapsed ? 40 : 220}
      minFirst={collapsed ? 40 : 140}
      maxFirst={collapsed ? 40 : 420}
      minSecond={400}
      disabled={collapsed || focusMode}
      collapseFirst={focusMode}
    >
      <RepoSidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      <div className="flex h-full min-h-0 min-w-0 flex-col">{main}</div>
    </Split>
  );
}
