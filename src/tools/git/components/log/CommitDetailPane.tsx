/**
 * Right pane on the Log tab: full commit message, file list with
 * status letters, and the unified diff for the selected file (rendered
 * via the shared `<DiffViewer>` from `@zen-tools/editor`).
 */

import { useEffect, useMemo, useState } from "react";
import { DiffViewer } from "@zen-tools/editor";
import { cn } from "@zen-tools/ui";

import {
  gitTauri,
  type Commit,
  type FileChange,
  type FileDiff,
} from "../../lib/tauri";
import { shortIso, statusColor } from "../../lib/format";
import { FileTree, type FileTreeItem } from "../shared/FileTree";

export interface CommitDetailPaneProps {
  repo: string;
  commit: Commit | null;
  isDark: boolean;
}

export function CommitDetailPane({
  repo,
  commit,
  isDark,
}: CommitDetailPaneProps) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [newContent, setNewContent] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // Load the file list when the commit changes.
  useEffect(() => {
    if (!commit) {
      setFiles([]);
      setActivePath(null);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    void (async () => {
      try {
        const fs = await gitTauri.commitFiles(repo, commit.hash);
        if (cancelled) return;
        setFiles(fs);
        setActivePath(fs[0]?.path ?? null);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: commitFiles failed", e);
        if (!cancelled) setFiles([]);
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, commit?.hash]);

  // Load the diff + old/new file contents when the active file changes.
  useEffect(() => {
    if (!commit || !activePath) {
      setDiff(null);
      setOldContent(null);
      setNewContent(null);
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    void (async () => {
      try {
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("git: commitDiff failed", e);
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
  }, [repo, commit?.hash, activePath]);

  if (!commit) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a commit to inspect.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <header className="border-b px-4 py-3">
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
          <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
            {commit.body}
          </pre>
        )}
      </header>

      {/* File list + diff */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="w-64 shrink-0 overflow-hidden border-r">
          <CommitFileTree
            files={files}
            loading={loadingFiles}
            activePath={activePath}
            onSelect={setActivePath}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {loadingDiff ? (
            <div className="p-4 text-xs text-muted-foreground">Loading diff…</div>
          ) : diff ? (
            <DiffViewer
              patch={diff.patch}
              fileName={activePath ?? undefined}
              oldContent={oldContent ?? undefined}
              newContent={newContent ?? undefined}
              isDark={isDark}
              viewMode="unified"
            />
          ) : (
            <div className="p-4 text-xs text-muted-foreground">
              Select a file to view its diff.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface CommitFileTreeProps {
  files: FileChange[];
  loading: boolean;
  activePath: string | null;
  onSelect: (path: string) => void;
}

function CommitFileTree({
  files,
  loading,
  activePath,
  onSelect,
}: CommitFileTreeProps) {
  const items = useMemo<FileTreeItem<FileChange>[]>(
    () => files.map((f) => ({ path: f.path, data: f })),
    [files],
  );
  if (loading) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">No files.</div>
    );
  }
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
