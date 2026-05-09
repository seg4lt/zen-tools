/**
 * Right pane on the Log tab: full commit message + the unified/split
 * diff for the file currently selected in the activity-bar side panel.
 *
 * Operates in two modes driven by the parent:
 *   - **Single-commit mode** (`rangeSpec === null`): fetches files +
 *     diff for one commit via `gitTauri.commitFiles` / `commitDiff`.
 *   - **Range mode** (`rangeSpec` set): the user has multi-selected N
 *     commits; we show the cumulative diff between
 *     `rangeSpec.from..rangeSpec.to` via `rangeDiffFiles` /
 *     `rangeDiffFile`.
 *
 * The file list itself isn't rendered here — it lives in the shared
 * "Files" tree on the left, hydrated from `logFiles` in the store.
 *
 * Two persistent toggles live in the diff toolbar:
 *   - Unified vs Split (`localStorage["git.log.diffViewMode"]`)
 *   - Show / hide diff body (`localStorage["git.log.diffVisible"]`)
 */

import { useEffect, useState } from "react";
import { Columns2, Eye, EyeOff, Rows2 } from "lucide-react";
import { DiffViewer, type DiffViewMode } from "@zen-tools/editor";
import { Button, cn } from "@zen-tools/ui";

import { gitTauri, type Commit, type FileDiff } from "../../lib/tauri";
import { shortIso } from "../../lib/format";
import { useGitStore } from "../../store/git-store";

const VIEW_MODE_KEY = "git.log.diffViewMode";
const DIFF_VISIBLE_KEY = "git.log.diffVisible";

function readViewMode(): DiffViewMode {
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_KEY);
    if (raw === "split" || raw === "unified") return raw;
  } catch {
    /* ignore */
  }
  return "unified";
}

function writeViewMode(m: DiffViewMode) {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, m);
  } catch {
    /* ignore */
  }
}

function readDiffVisible(): boolean {
  try {
    const raw = window.localStorage.getItem(DIFF_VISIBLE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function writeDiffVisible(v: boolean) {
  try {
    window.localStorage.setItem(DIFF_VISIBLE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * When a multi-selection is active, the parent collapses it into a
 * single revision range and hands us the endpoints + a few derived
 * fields for the header.
 */
export interface RangeSpec {
  from: string;
  to: string;
  oldest: Commit;
  newest: Commit;
  count: number;
}

export interface CommitDetailPaneProps {
  repo: string;
  commit: Commit | null;
  isDark: boolean;
  rangeSpec: RangeSpec | null;
}

export function CommitDetailPane({
  repo,
  commit,
  isDark,
  rangeSpec,
}: CommitDetailPaneProps) {
  const { state: storeState, dispatch } = useGitStore();
  const activePath = storeState.logActiveFilePath;

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [newContent, setNewContent] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() => readViewMode());
  const [diffVisible, setDiffVisible] = useState<boolean>(() =>
    readDiffVisible(),
  );

  // Load the file list — single commit OR range — and write into the
  // store. The side panel reads `logFiles` regardless of mode.
  useEffect(() => {
    if (rangeSpec) {
      let cancelled = false;
      void (async () => {
        try {
          const fs = await gitTauri.rangeDiffFiles(
            repo,
            rangeSpec.from,
            rangeSpec.to,
          );
          if (!cancelled) {
            // `sha = null` is fine here — the store treats it as
            // "synthetic / range" which won't match a real commit.
            dispatch({ type: "set-log-files", sha: null, files: fs });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("git: rangeDiffFiles failed", e);
          if (!cancelled)
            dispatch({ type: "set-log-files", sha: null, files: [] });
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (!commit) {
      dispatch({ type: "set-log-files", sha: null, files: [] });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fs = await gitTauri.commitFiles(repo, commit.hash);
        if (!cancelled)
          dispatch({ type: "set-log-files", sha: commit.hash, files: fs });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: commitFiles failed", e);
        if (!cancelled)
          dispatch({ type: "set-log-files", sha: null, files: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, commit?.hash, rangeSpec?.from, rangeSpec?.to, rangeSpec, commit, dispatch]);

  // Load the diff + old/new file contents when the active file
  // changes. Skipped entirely when the user has the diff hidden so
  // we don't pay the round-trip just to throw it away.
  useEffect(() => {
    if (!diffVisible) {
      setDiff(null);
      setOldContent(null);
      setNewContent(null);
      return;
    }
    if (!activePath || (!commit && !rangeSpec)) {
      setDiff(null);
      setOldContent(null);
      setNewContent(null);
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    void (async () => {
      try {
        if (rangeSpec) {
          const [d, oc, nc] = await Promise.all([
            gitTauri.rangeDiffFile(
              repo,
              rangeSpec.from,
              rangeSpec.to,
              activePath,
            ),
            gitTauri.fileAtRev(repo, rangeSpec.from, activePath).catch(() => ""),
            gitTauri.fileAtRev(repo, rangeSpec.to, activePath).catch(() => ""),
          ]);
          if (cancelled) return;
          setDiff(d);
          setOldContent(oc);
          setNewContent(nc);
        } else if (commit) {
          const parent = commit.parents[0] ?? `${commit.hash}^`;
          const [d, oc, nc] = await Promise.all([
            gitTauri.commitDiff(repo, commit.hash, activePath),
            gitTauri.fileAtRev(repo, parent, activePath).catch(() => ""),
            gitTauri.fileAtRev(repo, commit.hash, activePath).catch(() => ""),
          ]);
          if (cancelled) return;
          setDiff(d);
          setOldContent(oc);
          setNewContent(nc);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: load diff failed", e);
        if (!cancelled) {
          setDiff(null);
          setOldContent(null);
          setNewContent(null);
        }
      } finally {
        if (!cancelled) setLoadingDiff(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    repo,
    commit?.hash,
    rangeSpec?.from,
    rangeSpec?.to,
    rangeSpec,
    commit,
    activePath,
    diffVisible,
  ]);

  const updateViewMode = (m: DiffViewMode) => {
    setViewMode(m);
    writeViewMode(m);
  };

  const updateDiffVisible = (v: boolean) => {
    setDiffVisible(v);
    writeDiffVisible(v);
  };

  if (!commit && !rangeSpec) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a commit to inspect.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      {rangeSpec ? (
        <RangeHeader spec={rangeSpec} />
      ) : commit ? (
        <SingleCommitHeader commit={commit} />
      ) : null}

      {/* Diff toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {activePath ?? "—"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background/40 p-0.5">
          <ViewModeButton
            label="Unified"
            icon={<Rows2 className="h-3 w-3" />}
            active={viewMode === "unified"}
            onClick={() => updateViewMode("unified")}
          />
          <ViewModeButton
            label="Split"
            icon={<Columns2 className="h-3 w-3" />}
            active={viewMode === "split"}
            onClick={() => updateViewMode("split")}
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => updateDiffVisible(!diffVisible)}
          title={diffVisible ? "Hide diff" : "Show diff"}
          aria-pressed={!diffVisible}
          className="h-6 w-6"
        >
          {diffVisible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Diff body — `min-w-0` + `overflow-hidden` are essential so
          DiffViewer's wide CodeMirror lines don't push the parent
          flex container outward. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {!diffVisible ? (
          <div className="p-4 text-xs text-muted-foreground">
            Diff hidden. Click the eye icon to show it.
          </div>
        ) : loadingDiff ? (
          <div className="p-4 text-xs text-muted-foreground">Loading diff…</div>
        ) : !activePath ? (
          <div className="p-4 text-xs text-muted-foreground">
            Select a file in the sidebar to view its diff.
          </div>
        ) : diff ? (
          <div className="h-full w-full min-w-0 overflow-auto">
            <DiffViewer
              patch={diff.patch}
              fileName={activePath}
              oldContent={oldContent ?? undefined}
              newContent={newContent ?? undefined}
              isDark={isDark}
              viewMode={viewMode}
            />
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            No diff available for this file.
          </div>
        )}
      </div>
    </div>
  );
}

function SingleCommitHeader({ commit }: { commit: Commit }) {
  return (
    <header className="shrink-0 border-b px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
          {commit.shortHash}
        </code>
        <span>
          by{" "}
          <span className="font-medium text-foreground">
            {commit.authorName}
          </span>
        </span>
        <span>•</span>
        <span>{shortIso(commit.committerTs)}</span>
        {commit.refs.length > 0 && (
          <>
            <span>•</span>
            <span className="flex flex-wrap gap-1">
              {commit.refs.map((r) => (
                <span
                  key={r}
                  className="rounded border border-primary/30 bg-primary/10 px-1 font-mono text-[10px] leading-tight text-primary"
                >
                  {r}
                </span>
              ))}
            </span>
          </>
        )}
      </div>
      <h2 className="mt-1 break-words text-sm font-semibold">
        {commit.subject}
      </h2>
      {commit.body && (
        <pre className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
          {commit.body}
        </pre>
      )}
    </header>
  );
}

function RangeHeader({ spec }: { spec: RangeSpec }) {
  const { count, oldest, newest } = spec;
  return (
    <header className="shrink-0 border-b px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-primary">
          {count} commits
        </span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
          {oldest.shortHash}
        </code>
        <span>…</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
          {newest.shortHash}
        </code>
        <span>•</span>
        <span>
          {shortIso(oldest.committerTs)} → {shortIso(newest.committerTs)}
        </span>
      </div>
      <h2 className="mt-1 break-words text-sm font-semibold">
        Combined diff across {count} commits
      </h2>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Showing <code className="font-mono">{spec.from}..{spec.to}</code> —
        cumulative changes between the parent of{" "}
        <code className="font-mono">{oldest.shortHash}</code> and{" "}
        <code className="font-mono">{newest.shortHash}</code>.
      </p>
    </header>
  );
}

function ViewModeButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      aria-pressed={active}
      title={`${label} diff`}
      className={cn(
        "h-6 gap-1 px-1.5 text-[11px]",
        active && "bg-foreground/10 text-foreground",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}
