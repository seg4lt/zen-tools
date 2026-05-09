/**
 * Side-panel content for the "Repos" activity-bar mode.
 *
 * Content-only — the surrounding chrome (collapse button, panel
 * title bar) belongs to GitShell. This component just lists every
 * registered repo with add/remove affordances.
 */

import { Folder, FolderGit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, cn } from "@zen-tools/ui";

import { gitTauri, type RepoEntry } from "../lib/tauri";
import { repoBasename } from "../lib/format";
import { useGitStore } from "../store/git-store";

export function RepoSidebar() {
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

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-muted/10">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <FolderGit2 className="h-3 w-3 shrink-0" />
          <span className="truncate">Repositories</span>
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={onAdd}
          disabled={busy}
          title="Add repository…"
          className="h-6 w-6"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!state.reposLoaded ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : state.repos.length === 0 ? (
          <div className="px-3 py-6 text-xs text-muted-foreground">
            No repos yet. Click <span className="font-medium">+</span> to add
            one.
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
                      "group flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] hover:bg-accent",
                      isActive && "bg-accent font-medium",
                    )}
                    title={repo.path}
                  >
                    <Folder
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        isActive
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1 truncate">
                      {repo.label || repoBasename(repo.path)}
                    </span>
                    <Trash2
                      className="h-3 w-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
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
    </div>
  );
}
