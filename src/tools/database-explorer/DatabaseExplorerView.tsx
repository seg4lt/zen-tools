/**
 * Top-level layout for the Database Explorer:
 *
 *   ┌──────────────┬──────────────────────────────┬────────────────┐
 *   │ SQL Files    │ Connection tabs              │ Connections    │
 *   │ (project     ├──────────────────────────────┤ + DB tree      │
 *   │  tree)       │ Run toolbar                  │  (schema       │
 *   │              ├──────────────────────────────┤   browser)     │
 *   │              │ SQL editor                   │                │
 *   │              ├──────────────────────────────┤                │
 *   │              │ Results grid                 │                │
 *   └──────────────┴──────────────────────────────┴────────────────┘
 *
 * - **Left**: project folders + their `.sql` files. Click a file to
 *   open it in the editor.
 * - **Centre**: tabs for currently-connected DBs, a Run toolbar with
 *   the database/schema picker, the SQL editor (whose content IS the
 *   selected file's content), and the results grid.
 * - **Right**: connection list + database/schema/table tree
 *   (read-only schema browser).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { ConnectionList } from "./components/connection-list";
import { ConnectionForm } from "./components/connection-form";
import { ConnectionTabs } from "./components/connection-tabs";
import { DbTree } from "./components/db-tree";
import { SqlFileTree } from "./components/sql-file-tree";
import {
  SqlEditor,
  type SqlEditorHandle,
} from "./components/sql-editor";
import { RunToolbar } from "./components/run-toolbar";
import { ResultsGrid } from "./components/results-grid";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery } from "./hooks/use-db-query";
import { useSqlProjectsBootstrap } from "./hooks/use-sql-workspace";
import { sqlWorkspaceTauri, type SqlFileTreeItem } from "./lib/tauri";
import { formatError } from "./lib/format-error";
import { useVimMode } from "@/tools/http-runner/hooks/use-vim-mode";

export function DatabaseExplorerView() {
  useSqlProjectsBootstrap();

  const { state, dispatch } = useDbExplorerStore();
  const { runQuery } = useDbQuery();
  const { vimMode } = useVimMode();
  const editorRef = useRef<SqlEditorHandle | null>(null);

  const activeId = state.activeConnectionId;
  const active = useMemo(
    () => state.connections.find((c) => c.id === activeId) ?? null,
    [state.connections, activeId],
  );
  const status = activeId ? state.status[activeId] : undefined;
  const isConnected = status === "connected";
  const isRunning = activeId ? !!state.running[activeId] : false;
  const results = activeId ? state.resultsByConnection[activeId] ?? null : null;
  const error = activeId ? state.errors[activeId] ?? null : null;

  const selectedPath = state.selectedFilePath;
  const buffer = selectedPath
    ? state.bufferByPath[selectedPath] ?? ""
    : "";
  const isDirty = selectedPath
    ? !!state.dirtyByPath[selectedPath]
    : false;

  const activeDatabase = activeId
    ? state.activeDbByConnection[activeId] ?? active?.database ?? null
    : null;
  const activeSchema = activeId
    ? state.activeSchemaByConnection[activeId] ?? null
    : null;

  // Load file content when the user picks a new file in the tree.
  // We don't blow away an existing in-memory buffer (so re-clicking
  // a dirty file doesn't lose unsaved edits).
  useEffect(() => {
    if (!selectedPath) return;
    if (state.bufferByPath[selectedPath] !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const content = await sqlWorkspaceTauri.readFile(selectedPath);
        if (cancelled) return;
        dispatch({
          type: "set-buffer",
          path: selectedPath,
          content,
          dirty: false,
        });
        editorRef.current?.setValue(content);
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error("read file failed", formatError(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  // Keep the editor in sync when switching between already-loaded files.
  useEffect(() => {
    if (!selectedPath) return;
    const cached = state.bufferByPath[selectedPath];
    if (cached === undefined) return;
    editorRef.current?.setValue(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  const handleSelectFile = useCallback(
    (item: SqlFileTreeItem) => {
      if (item.isDir) return;
      dispatch({ type: "select-file", path: item.path });
    },
    [dispatch],
  );

  const handleEditorChange = useCallback(
    (next: string) => {
      if (!selectedPath) return;
      dispatch({
        type: "set-buffer",
        path: selectedPath,
        content: next,
        dirty: true,
      });
    },
    [selectedPath, dispatch],
  );

  const handleSave = useCallback(
    async (next: string) => {
      if (!selectedPath) return;
      try {
        await sqlWorkspaceTauri.writeFile(selectedPath, next);
        dispatch({ type: "mark-clean", path: selectedPath });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("write file failed", formatError(err));
      }
    },
    [selectedPath, dispatch],
  );

  const handleRun = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    const sqlToRun = selection.trim().length > 0 ? selection : editor.getValue();
    runQuery(activeId, sqlToRun, {
      database:
        active?.driver === "mssql" && activeDatabase ? activeDatabase : null,
      schema:
        active?.driver === "postgres" && activeSchema ? activeSchema : null,
    });
  }, [activeId, runQuery, active?.driver, activeDatabase, activeSchema]);

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Left: SQL file tree */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/60">
        <SqlFileTree
          selectedPath={selectedPath}
          onSelect={handleSelectFile}
        />
      </aside>

      {/* Centre: tabs + toolbar + editor + results */}
      <section className="flex min-w-0 flex-1 flex-col">
        <ConnectionTabs />
        <RunToolbar
          connection={active}
          isConnected={isConnected}
          isRunning={isRunning}
          results={results}
          error={error}
          onRun={handleRun}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-[200px] flex-1 border-b border-border/60">
            {selectedPath ? (
              <SqlEditor
                key={selectedPath}
                imperativeRef={editorRef}
                driver={active?.driver ?? "postgres"}
                value={buffer}
                onChange={handleEditorChange}
                onSave={handleSave}
                onRun={handleRun}
                vimMode={vimMode}
              />
            ) : (
              <EmptyEditor />
            )}
          </div>
          <FileFooter path={selectedPath} dirty={isDirty} />
          <div className="min-h-[200px] flex-1">
            <ResultsGrid results={results} />
          </div>
        </div>
      </section>

      {/* Right: connections + schema browser */}
      <aside className="flex w-72 shrink-0 flex-col border-l border-border/60">
        <div className="shrink-0 border-b border-border/60">
          <ConnectionList />
        </div>
        <div className="flex-1 overflow-auto">
          <DbTree />
        </div>
      </aside>

      <ConnectionForm />
    </div>
  );
}

function EmptyEditor() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-muted-foreground">
      <span>No file open.</span>
      <span>Add a project folder on the left, then pick a .sql file.</span>
    </div>
  );
}

function FileFooter({
  path,
  dirty,
}: {
  path: string | null;
  dirty: boolean;
}) {
  if (!path) return null;
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/20 px-3 py-0.5 text-[10px] text-muted-foreground">
      <span className="truncate font-mono" title={path}>
        {path}
      </span>
      <span>
        {dirty ? (
          <span className="text-foreground/80">● unsaved</span>
        ) : (
          <span>saved</span>
        )}
        <span className="ml-2 opacity-60">⌘S</span>
      </span>
    </div>
  );
}
