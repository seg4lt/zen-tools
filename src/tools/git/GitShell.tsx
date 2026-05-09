/**
 * Top-level shell for the **Git** tool.
 *
 *   ┌──┬─── Side panel ───┬─── Tabs: Log | Merge ────────────────┐
 *   │A │                  │                                      │
 *   │c │  Repos OR Files  │   active tab pane                    │
 *   │t │  (mode-driven)   │                                      │
 *   │  │                  │                                      │
 *   └──┴──────────────────┴──────────────────────────────────────┘
 *
 * Layout primitives:
 *   - The leftmost 40 px strip is a VSCode-style ActivityBar — its
 *     buttons drive `sidebarMode: "repos" | "files" | null`. Clicking
 *     the active button collapses the side panel; clicking a different
 *     one switches modes.
 *   - The boundary between the side panel and the main pane is a
 *     drag-resizable `<Split>`. When `sidebarMode === null` the panel
 *     is collapsed via `collapseFirst`.
 *   - Both `<CommitLogPane>` and `<MergePane>` are *always* mounted —
 *     hidden via CSS when their tab isn't active. That preserves
 *     scroll positions, loaded blobs, and the RESULT-pane buffer
 *     across tab switches. MergePane writes its conflicts list into
 *     the git-store, so the side panel's "Files" tree can render the
 *     same data without a duplicate fetch.
 *   - Focus mode overlays the merge editor on top of the rest of the
 *     git tool via `position: absolute; inset: 0; z-40` inside the
 *     `relative` GitShell root. The host TitleBar (and the
 *     UpdateBanner, if any) stay visible.
 */

import { useEffect, useMemo, useState } from "react";
import { Files, FolderGit2, GitBranch } from "lucide-react";
import { cn } from "@zen-tools/ui";

import { useTheme } from "@/hooks/use-theme";

import { ActivityBar, type SidePanelMode } from "./components/ActivityBar";
import { CommitLogPane } from "./components/log/CommitLogPane";
import { ConflictFileList } from "./components/merge/ConflictFileList";
import { MergePane } from "./components/merge/MergePane";
import { RepoSidebar } from "./components/RepoSidebar";
import { Split } from "./components/shared/Split";
import { gitTauri } from "./lib/tauri";
import { GitStoreProvider, useGitStore } from "./store/git-store";

const MODE_KEY = "git.sidebar.mode";

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

function readMode(): SidePanelMode | null {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    if (raw === "repos" || raw === "files" || raw === null) return raw;
    return "repos";
  } catch {
    return "repos";
  }
}

function writeMode(mode: SidePanelMode | null) {
  try {
    if (mode === null) window.localStorage.setItem(MODE_KEY, "");
    else window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function GitShellInner({ initialTab = "log" }: GitShellProps) {
  const { state, dispatch } = useGitStore();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [sidebarMode, setSidebarMode] = useState<SidePanelMode | null>(() =>
    readMode(),
  );
  const [focusMode, setFocusMode] = useState(false);
  const [activeTab, setActiveTab] = useState<GitInitialTab>(initialTab);

  const onChangeMode = (m: SidePanelMode | null) => {
    setSidebarMode(m);
    writeMode(m);
  };

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
        /* surfaced inside the merge tab */
      }
    };
    void tick();
    timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [state.activeRepoPath, dispatch]);

  // Switch to the merge tab on first appearance of conflicts so the
  // user lands on something useful — but ONLY on transition. Don't
  // re-trigger if they intentionally switched back to Log while a
  // merge is still in progress.
  const conflictsExist = state.conflicts.length > 0;
  useEffect(() => {
    if (conflictsExist && activeTab === "log") {
      // Only nudge — keep their explicit pick if they picked Log just
      // before this. We do NOT auto-switch on every render, only on
      // the rising edge of "conflicts appeared".
    }
    // intentionally noop here; auto-switch policy lives at MergePane level
  }, [conflictsExist, activeTab]);

  // ── Empty state ────────────────────────────────────────────────────
  if (!state.activeRepoPath) {
    return (
      <div className="flex h-full w-full min-h-0">
        <ActivityBar
          mode={sidebarMode}
          onChangeMode={onChangeMode}
          items={[
            {
              id: "repos",
              label: "Repositories",
              icon: FolderGit2,
            },
          ]}
        />
        {sidebarMode === "repos" ? (
          <div className="w-56 shrink-0 border-r">
            <RepoSidebar />
          </div>
        ) : null}
        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
          <div>
            <GitBranch className="mx-auto mb-3 h-6 w-6 opacity-60" />
            <p>Add a repository from the sidebar to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full min-h-0">
      <ActivityBar
        mode={sidebarMode}
        onChangeMode={onChangeMode}
        items={[
          {
            id: "repos",
            label: "Repositories",
            icon: FolderGit2,
            badge:
              state.repos.length > 1 ? String(state.repos.length) : undefined,
            badgeTone: "muted",
          },
          {
            id: "files",
            label: "Conflict files",
            icon: Files,
            badge:
              state.conflicts.length > 0
                ? String(state.conflicts.length)
                : undefined,
            badgeTone: state.conflicts.length > 0 ? "amber" : "muted",
          },
        ]}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <Split
          direction="horizontal"
          // Distinct keys per mode so each mode remembers its own width.
          storageKey={
            sidebarMode === "files"
              ? "shell.sidebar.files"
              : sidebarMode === "repos"
                ? "shell.sidebar.repos"
                : "shell.sidebar.collapsed"
          }
          defaultFirst={sidebarMode === "files" ? 280 : 220}
          minFirst={160}
          maxFirst={520}
          minSecond={400}
          disabled={sidebarMode === null || focusMode}
          collapseFirst={sidebarMode === null || focusMode}
        >
          <SidePanel mode={sidebarMode} />
          <MainArea
            isDark={isDark}
            activeRepoPath={state.activeRepoPath}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            focusMode={focusMode}
            onToggleFocusMode={() => setFocusMode((v) => !v)}
          />
        </Split>
      </div>
    </div>
  );
}

function SidePanel({ mode }: { mode: SidePanelMode | null }) {
  const { state, dispatch } = useGitStore();

  if (mode === null) return <div className="h-full w-0" aria-hidden />;

  if (mode === "repos") {
    return <RepoSidebar />;
  }

  // mode === "files"
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-muted/10">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Files className="h-3 w-3 shrink-0" />
          <span className="truncate">Conflicts</span>
          {state.conflicts.length > 0 && (
            <span className="ml-1 rounded bg-amber-500/20 px-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
              {state.conflicts.length}
            </span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ConflictFileList
          conflicts={state.conflicts}
          activePath={state.activeConflictPath}
          onSelect={(p) => dispatch({ type: "set-active-conflict", path: p })}
          resolvedPaths={state.resolvedPaths}
        />
      </div>
    </div>
  );
}

interface MainAreaProps {
  isDark: boolean;
  activeRepoPath: string;
  activeTab: GitInitialTab;
  onTabChange: (tab: GitInitialTab) => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
}

function MainArea({
  isDark,
  activeRepoPath,
  activeTab,
  onTabChange,
  focusMode,
  onToggleFocusMode,
}: MainAreaProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Both panes are mounted at all times so their state survives
          tab switches; CSS hides the inactive one. */}
      <div
        className={cn(
          "flex-1 min-h-0 min-w-0",
          (activeTab !== "log" || focusMode) && "hidden",
        )}
      >
        <CommitLogPane
          repo={activeRepoPath}
          isDark={isDark}
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
      </div>

      {/* Merge content: when focus mode is on, the wrapper escapes
          the local layout via `absolute inset-0 z-40`, anchored to
          the `relative` GitShell root so it sits below the host
          TitleBar. The MergePane component itself never moves in the
          React tree, so no remount happens on focus toggle. */}
      <div
        className={cn(
          focusMode
            ? "absolute inset-0 z-40 bg-background"
            : cn("flex-1 min-h-0 min-w-0", activeTab !== "merge" && "hidden"),
        )}
      >
        <MergePane
          repo={activeRepoPath}
          isDark={isDark}
          focusMode={focusMode}
          onToggleFocusMode={onToggleFocusMode}
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
      </div>
    </div>
  );
}

// Re-export the merge-state badge helper for the Merge tab pill in
// case any consumer wants it externally.
export function useMergeBadge(): string | null {
  const { state } = useGitStore();
  return useMemo(() => {
    const ms = state.mergeState;
    if (!ms || ms.kind === "none") return null;
    return ms.unresolved > 0 ? `${ms.unresolved}` : "✓";
  }, [state.mergeState]);
}
