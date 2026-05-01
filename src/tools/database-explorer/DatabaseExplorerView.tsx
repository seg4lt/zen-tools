/**
 * Top-level layout for the Database Explorer:
 *
 *   ┌──────────────────────┬──────────────────────────────────┐
 *   │ Connections          │ Run Toolbar                      │
 *   │ + tree (databases…)  ├──────────────────────────────────┤
 *   │                      │ SQL Editor                       │
 *   │                      ├──────────────────────────────────┤
 *   │                      │ Results Grid                     │
 *   └──────────────────────┴──────────────────────────────────┘
 */

import { useCallback, useMemo, useRef } from "react";
import { ConnectionList } from "./components/connection-list";
import { ConnectionForm } from "./components/connection-form";
import { ConnectionTabs } from "./components/connection-tabs";
import { DbTree } from "./components/db-tree";
import {
  SqlEditor,
  type SqlEditorHandle,
} from "./components/sql-editor";
import { RunToolbar } from "./components/run-toolbar";
import { ResultsGrid } from "./components/results-grid";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery } from "./hooks/use-db-query";
import { useVimMode } from "@/tools/http-runner/hooks/use-vim-mode";

export function DatabaseExplorerView() {
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
  const sql = activeId ? state.sqlByConnection[activeId] ?? defaultSql : "";

  const activeDatabase = activeId
    ? state.activeDbByConnection[activeId] ?? active?.database ?? null
    : null;
  const activeSchema = activeId
    ? state.activeSchemaByConnection[activeId] ?? null
    : null;

  const handleRun = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    const sqlToRun = selection.trim().length > 0 ? selection : editor.getValue();
    // Only the relevant driver actually consumes each — Postgres uses
    // schema, MSSQL uses database. Backend ignores the irrelevant one.
    runQuery(activeId, sqlToRun, {
      database:
        active?.driver === "mssql" && activeDatabase ? activeDatabase : null,
      schema:
        active?.driver === "postgres" && activeSchema ? activeSchema : null,
    });
  }, [activeId, runQuery, active?.driver, activeDatabase, activeSchema]);

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Left column: connections + tree */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/60">
        <div className="shrink-0 border-b border-border/60">
          <ConnectionList />
        </div>
        <div className="flex-1 overflow-auto">
          <DbTree />
        </div>
      </aside>

      {/* Right column: tabs + editor + results */}
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
            {activeId ? (
              <SqlEditor
                key={activeId}
                imperativeRef={editorRef}
                driver={active?.driver ?? "postgres"}
                value={sql}
                onChange={(v) =>
                  dispatch({ type: "set-sql", id: activeId, sql: v })
                }
                onRun={handleRun}
                vimMode={vimMode}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Add or select a connection to start writing SQL.
              </div>
            )}
          </div>
          <div className="min-h-[200px] flex-1">
            <ResultsGrid results={results} />
          </div>
        </div>
      </section>

      <ConnectionForm />
    </div>
  );
}

const defaultSql = `-- Pick or add a connection on the left, then press ⌘↵ to run.
SELECT 1 AS hello;
`;
