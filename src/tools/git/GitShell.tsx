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
import { FileTree, type FileTreeItem } from "./components/shared/FileTree";
import { Split } from "./components/shared/Split";
import { gitTauri, type FileChange } from "./lib/tauri";
import { statusColor } from "./lib/format";
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

  // The Files activity-bar item is *context-aware*: on the Merge tab
  // it shows conflicting files and the count; on the Log tab it shows
  // the selected commit's changed files. Same icon, same toggle, the
  // tree just morphs to match the current tab.
  const filesBadge =
    activeTab === "merge"
      ? state.conflicts.length > 0
        ? String(state.conflicts.length)
        : undefined
      : state.logFiles.length > 0
        ? String(state.logFiles.length)
        : undefined;
  const filesBadgeTone =
    activeTab === "merge" && state.conflicts.length > 0 ? "amber" : "muted";

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
            label: activeTab === "merge" ? "Conflict files" : "Commit files",
            icon: Files,
            badge: filesBadge,
            badgeTone: filesBadgeTone,
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
          <SidePanel mode={sidebarMode} activeTab={activeTab} />
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

function SidePanel({
  mode,
  activeTab,
}: {
  mode: SidePanelMode | null;
  activeTab: GitInitialTab;
}) {
  const { state, dispatch } = useGitStore();

  if (mode === null) return <div className="h-full w-0" aria-hidden />;
  if (mode === "repos") return <RepoSidebar />;

  // mode === "files" — Files panel is tab-aware.
  if (activeTab === "merge") {
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
            onSelect={(p) =>
              dispatch({ type: "set-active-conflict", path: p })
            }
            resolvedPaths={state.resolvedPaths}
          />
        </div>
      </div>
    );
  }

  // activeTab === "log"
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-muted/10">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Files className="h-3 w-3 shrink-0" />
          <span className="truncate">Files</span>
          {state.logFiles.length > 0 && (
            <span className="ml-1 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              {state.logFiles.length}
            </span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <CommitFilesPanel />
      </div>
    </div>
  );
}

function CommitFilesPanel() {
  const { state, dispatch } = useGitStore();
  if (state.logSelectedSha == null) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        Pick a commit to see its files.
      </div>
    );
  }
  if (state.logFiles.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No files in this commit.
      </div>
    );
  }
  return (
    <CommitFilesTree
      files={state.logFiles}
      activePath={state.logActiveFilePath}
      onSelect={(p) => dispatch({ type: "set-log-active-file", path: p })}
    />
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
          tab switches; CSS hides the inactive one. Focus mode is
          tab-aware: when the Log tab is the active one, the log pane
          escapes the layout via `absolute inset-0`. The Merge tab
          uses the same pattern. */}
      <div
        className={cn(
          focusMode && activeTab === "log"
            ? "absolute inset-0 z-40 bg-background"
            : cn(
                "flex-1 min-h-0 min-w-0",
                (activeTab !== "log" || focusMode) && "hidden",
              ),
        )}
      >
        <CommitLogPane
          repo={activeRepoPath}
          isDark={isDark}
          activeTab={activeTab}
          onTabChange={onTabChange}
          focusMode={focusMode && activeTab === "log"}
          onToggleFocusMode={onToggleFocusMode}
        />
      </div>

      {/* Merge content: when focus mode is on, the wrapper escapes
          the local layout via `absolute inset-0 z-40`, anchored to
          the `relative` GitShell root so it sits below the host
          TitleBar. The MergePane component itself never moves in the
          React tree, so no remount happens on focus toggle. */}
      <div
        className={cn(
          focusMode && activeTab === "merge"
            ? "absolute inset-0 z-40 bg-background"
            : cn("flex-1 min-h-0 min-w-0", activeTab !== "merge" && "hidden"),
        )}
      >
        <MergePane
          repo={activeRepoPath}
          isDark={isDark}
          focusMode={focusMode && activeTab === "merge"}
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

interface CommitFilesTreeProps {
  files: FileChange[];
  activePath: string | null;
  onSelect: (path: string) => void;
}

function CommitFilesTree({ files, activePath, onSelect }: CommitFilesTreeProps) {
  const items = useMemo<FileTreeItem<FileChange>[]>(
    () => files.map((f) => ({ path: f.path, data: f })),
    [files],
  );
  return (
    <FileTree
      items={items}
      selectedPath={activePath}
      onSelect={onSelect}
      renderLeaf={(f, { basename }) => (
        <>
          <span
            className={cn(
              "w-4 shrink-0 font-mono text-[11px]",
              statusColor(f.status),
            )}
            title={f.status}
          >
            {f.status}
          </span>
          <span className="truncate font-mono">{basename}</span>
        </>
      )}
    />
  );
}
