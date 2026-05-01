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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CacheStatusBadge } from "./components/cache-status-badge";
import { ConnectionList } from "./components/connection-list";
import { ConnectionForm } from "./components/connection-form";
import { ConnectionTabs } from "./components/connection-tabs";
import { DbTree } from "./components/db-tree";
import { SqlFileTree } from "./components/sql-file-tree";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import {
  SqlEditor,
  type SqlEditorHandle,
} from "./components/sql-editor";
import { SchemaProgressIndicator } from "./components/schema-progress-indicator";
import { RunToolbar } from "./components/run-toolbar";
import { ResultsPane } from "./components/results-pane";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery } from "./hooks/use-db-query";
import { useSqlProjectsBootstrap } from "./hooks/use-sql-workspace";
import { sqlWorkspaceTauri, type SqlFileTreeItem } from "./lib/tauri";
import { formatError } from "./lib/format-error";
import { statementAtCursor } from "./lib/sql-statements";
import { ensureTablesForSql } from "./lib/schema-cache";
import { useAutoSave } from "@/hooks/use-auto-save";
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
  // UI-only — maximize the results pane to fill the centre column,
  // hiding the editor + footer. Click the icon on any result tab to
  // toggle. Reset when the user switches files (so a fresh file
  // doesn't open in a hidden editor).
  const [resultsMaximized, setResultsMaximized] = useState(false);

  // Drag-resizable panel sizes (local-state only, not persisted —
  // matches the http-runner pattern). Defaults mirror the previous
  // hard-coded Tailwind widths: w-64 = 256, w-72 = 288.
  const [leftWidth, setLeftWidth] = useState(256);
  const [rightWidth, setRightWidth] = useState(288);
  const [resultsHeight, setResultsHeight] = useState(320);

  // Per-rail collapse state — user-controlled via the chevron in the
  // rail's header. Maximize forces both to collapse so the results
  // pane truly fills the viewport, then restoring brings them back to
  // whatever the user had previously set. The drag handles + the
  // editor pane disappear in lockstep with the rails.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const effectiveLeftCollapsed = resultsMaximized || leftCollapsed;
  const effectiveRightCollapsed = resultsMaximized || rightCollapsed;
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

  // Shared trailing-edge debounce. Keystrokes flip dirty=true and
  // update the buffer; `useAutoSave` handles the timer, file-switch
  // flush, and unmount flush. ⌘S (handleSave below) calls
  // `autoSave.flush()` to short-circuit the timer.
  const autoSave = useAutoSave({
    key: selectedPath,
    content: buffer,
    dirty: isDirty,
    save: useCallback(
      async (path: string, content: string) => {
        await sqlWorkspaceTauri.writeFile(path, content);
        dispatch({ type: "mark-clean", path });
      },
      [dispatch],
    ),
  });

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
      // ⌘S takes the editor's current value as the source of truth
      // (the autosave hook's pending ref might be one render behind).
      // Cancel the pending debounce so it can't re-fire with stale
      // bytes a second later.
      autoSave.cancel();
      try {
        await sqlWorkspaceTauri.writeFile(selectedPath, next);
        dispatch({ type: "mark-clean", path: selectedPath });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("write file failed", formatError(err));
      }
    },
    [selectedPath, dispatch, autoSave],
  );

  const ctxOpts = useMemo(
    () => ({
      database:
        active?.driver === "mssql" && activeDatabase ? activeDatabase : null,
      schema:
        active?.driver === "postgres" && activeSchema ? activeSchema : null,
    }),
    [active?.driver, activeDatabase, activeSchema],
  );

  /**
   * DataGrip-style Run:
   *   - selection?  run the selection (may span multiple statements)
   *   - else        run the statement under the cursor
   *
   * Bound to Cmd+Enter via the editor keymap and to the Run button.
   */
  /**
   * Best-effort default schema for cache prefetch on run. Postgres
   * defaults to `public`; MSSQL to `dbo`. Used only by
   * `ensureTablesForSql` to bucket bare refs — the actual query
   * still runs with whatever `ctxOpts` already carries.
   */
  const cacheDefaultSchema =
    activeSchema ?? (active?.driver === "postgres" ? "public" : "dbo");

  /** Trigger cache fill for every table in the SQL we're about to
   * run. Fire-and-forget so the run itself is never blocked; the
   * progress chip surfaces what's actually being indexed. */
  const ensureCacheForSql = useCallback(
    (sqlText: string) => {
      if (!activeId || !activeDatabase) return;
      ensureTablesForSql(
        activeId,
        activeDatabase,
        cacheDefaultSchema,
        sqlText,
      );
    },
    [activeId, activeDatabase, cacheDefaultSchema],
  );

  const handleRun = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    if (selection.trim().length > 0) {
      ensureCacheForSql(selection);
      runQuery(activeId, selection, ctxOpts);
      return;
    }
    const buffer = editor.getValue();
    const cursor = editor.getCursorOffset();
    const stmt = statementAtCursor(buffer, cursor);
    if (!stmt) return;
    ensureCacheForSql(stmt.sql);
    runQuery(activeId, stmt.sql, ctxOpts);
  }, [activeId, runQuery, ctxOpts, ensureCacheForSql]);

  /** Explicit "run every statement in the buffer". */
  const handleRunAll = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const buffer = editor.getValue();
    if (buffer.trim().length === 0) return;
    ensureCacheForSql(buffer);
    runQuery(activeId, buffer, ctxOpts);
  }, [activeId, runQuery, ctxOpts, ensureCacheForSql]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden">
      {/* Schema-cache progress chip(s). Position: fixed bottom-right of
          the viewport via the component's own styling — render
          location in the tree doesn't matter, but mounting it here
          keeps the indicator scoped to the database-explorer view. */}
      <SchemaProgressIndicator />
      {/* Left: SQL file tree.
          Note: the row root has `min-w-0 overflow-hidden` because flex
          children default to `min-width: auto` (intrinsic content). A
          wide results grid would otherwise propagate its min-content
          width up the tree and slide the whole layout off-screen,
          since the asides are `shrink-0`. With this clip, only the
          inner scroll container grows past its parent and engages its
          own scrollbar. */}
      {effectiveLeftCollapsed ? (
        // Collapsed: a thin vertical strip with an "open" chevron so
        // the user always sees a way back. Hidden when the results
        // pane is maximized — that mode wants the entire viewport.
        !resultsMaximized && (
          <CollapsedRail
            side="left"
            title="Show SQL Files"
            onExpand={() => setLeftCollapsed(false)}
          />
        )
      ) : (
        <>
          <aside
            className="flex shrink-0 flex-col border-r border-border/60"
            style={{ width: leftWidth }}
          >
            <SqlFileTree
              selectedPath={selectedPath}
              onSelect={handleSelectFile}
              onCollapse={() => setLeftCollapsed(true)}
            />
          </aside>
          <DragHandle
            direction="x"
            initial={leftWidth}
            min={180}
            max={520}
            onResize={setLeftWidth}
          />
        </>
      )}

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
          onRunAll={handleRunAll}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!resultsMaximized && (
            <>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden border-b border-border/60">
                {selectedPath ? (
                  <SqlEditor
                    key={selectedPath}
                    imperativeRef={editorRef}
                    driver={active?.driver ?? "postgres"}
                    connectionId={activeId}
                    database={activeDatabase}
                    schema={activeSchema}
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
              <DragHandle
                direction="y"
                inverse
                initial={resultsHeight}
                min={120}
                max={800}
                onResize={setResultsHeight}
              />
            </>
          )}
          {/* The results pane has a fixed pixel height (drag-resizable)
              when not maximized; when maximized, it absorbs the rest of
              the column via flex-1. Either way, `overflow-hidden` on
              the wrapper guarantees a wide grid scrolls inside instead
              of pushing side rails off-screen. */}
          <div
            className="min-w-0 overflow-hidden"
            style={
              resultsMaximized
                ? { flex: "1 1 auto", minHeight: 0 }
                : { height: resultsHeight, flex: "none" }
            }
          >
            <ResultsPane
              connectionId={activeId}
              results={results}
              maximized={resultsMaximized}
              onToggleMaximize={() => setResultsMaximized((m) => !m)}
            />
          </div>
        </div>
      </section>

      {effectiveRightCollapsed ? (
        !resultsMaximized && (
          <CollapsedRail
            side="right"
            title="Show Connections"
            onExpand={() => setRightCollapsed(false)}
          />
        )
      ) : (
        <>
          <DragHandle
            direction="x"
            inverse
            initial={rightWidth}
            min={200}
            max={520}
            onResize={setRightWidth}
          />
          {/* Right: connections + schema browser */}
          <aside
            className="flex shrink-0 flex-col border-l border-border/60"
            style={{ width: rightWidth }}
          >
            <div className="shrink-0 border-b border-border/60">
              <ConnectionList onCollapse={() => setRightCollapsed(true)} />
            </div>
            {/* Schema-cache status — pinned to the right rail above
                the DB tree so the user always has a fixed place to
                see "X/Y tables indexed" and watch live indexing
                progress. Hides itself when no connection is live. */}
            <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
              <CacheStatusBadge />
            </div>
            <div className="flex-1 overflow-auto">
              <DbTree />
            </div>
          </aside>
        </>
      )}

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

/**
 * Thin vertical strip rendered in place of a collapsed side rail. The
 * single button restores the full panel. Border side flips so the
 * strip sits flush against the centre column on the correct edge.
 */
function CollapsedRail({
  side,
  title,
  onExpand,
}: {
  side: "left" | "right";
  title: string;
  onExpand: () => void;
}) {
  return (
    <div
      className={
        "flex w-7 shrink-0 flex-col items-center bg-muted/20 py-1 " +
        (side === "left"
          ? "border-r border-border/60"
          : "border-l border-border/60")
      }
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        title={title}
        onClick={onExpand}
      >
        {side === "left" ? (
          <PanelLeftOpen className="size-3" />
        ) : (
          <PanelRightOpen className="size-3" />
        )}
      </Button>
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
