/**
 * Left rail: list every registered repo, mark the active one, and
 * expose add / remove via the rail itself. Mirrors the cleaner-tool
 * pattern of server-side persistence + a thin UI.
 *
 * Has two modes:
 *   - **Expanded** (default): full-width labels.
 *   - **Collapsed**: thin strip with icon-only repos, an expand
 *     button, and an add (+) button. Stored under
 *     `localStorage["git.sidebar.collapsed"]` so the choice
 *     survives reloads.
 */

import {
  Folder,
  FolderGit2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button, cn } from "@zen-tools/ui";

import { gitTauri, type RepoEntry } from "../lib/tauri";
import { repoBasename } from "../lib/format";
import { useGitStore } from "../store/git-store";

export interface RepoSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function RepoSidebar({ collapsed, onToggleCollapsed }: RepoSidebarProps) {
  const { state, dispatch } = useGitStore();
  const [busy, setBusy] = useState(false);

  const onAdd = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const entry = await gitTauri.pickAndAddRepo();
      if (entry) {
        const repos = await gitTauri.listRepos();
        dispatch({ type: "set-repos", repos });
        dispatch({ type: "set-active", path: entry.path });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("git: pickAndAddRepo failed", e);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (entry: RepoEntry) => {
    try {
      await gitTauri.removeRepo(entry.path);
      dispatch({ type: "remove-repo", path: entry.path });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("git: removeRepo failed", e);
    }
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 py-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleCollapsed}
          title="Expand repository list"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onAdd}
          disabled={busy}
          title="Add repository…"
        >
          <Plus className="h-4 w-4" />
        </Button>
        <div className="mt-1 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {state.repos.map((repo) => {
            const isActive = repo.path === state.activeRepoPath;
            return (
              <button
                key={repo.path}
                type="button"
                onClick={() =>
                  dispatch({ type: "set-active", path: repo.path })
                }
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  isActive && "bg-accent text-foreground",
                )}
                title={`${repo.label || repoBasename(repo.path)}\n${repo.path}`}
              >
                <Folder className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Repositories</span>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            onClick={onAdd}
            disabled={busy}
            title="Add repository…"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleCollapsed}
            title="Collapse"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!state.reposLoaded ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : state.repos.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground">
            No repos yet. Click <span className="font-medium">+</span> to add one.
          </div>
        ) : (
          <ul className="flex flex-col">
            {state.repos.map((repo) => {
              const isActive = repo.path === state.activeRepoPath;
              return (
                <li key={repo.path}>
                  <button
                    type="button"
                    onClick={() =>
                      dispatch({ type: "set-active", path: repo.path })
                    }
                    className={cn(
                      "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                      isActive && "bg-accent font-medium",
                    )}
                    title={repo.path}
                  >
                    <Folder
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1 truncate">
                      {repo.label || repoBasename(repo.path)}
                    </span>
                    <Trash2
                      className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemove(repo);
                      }}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
