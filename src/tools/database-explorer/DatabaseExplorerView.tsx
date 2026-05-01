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
import { RunToolbar } from "./components/run-toolbar";
import { ResultsPane } from "./components/results-pane";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery } from "./hooks/use-db-query";
import { useSqlProjectsBootstrap } from "./hooks/use-sql-workspace";
import { sqlWorkspaceTauri, type SqlFileTreeItem } from "./lib/tauri";
import { formatError } from "./lib/format-error";
import { statementAtCursor } from "./lib/sql-statements";
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

  // ── Auto-save (1 s trailing-edge debounce) ────────────────────────
  //
  // `pendingRef` holds the file path + last-typed content waiting to
  // hit disk. `timerRef` holds the active setTimeout handle. Each
  // keystroke clears the previous timer and re-arms — only the LAST
  // version inside a quiet 1 s window actually writes, mirroring
  // VS Code / IntelliJ. Manual ⌘S, file-switch, and unmount all
  // call `flushAutoSave()` which writes immediately.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSavePendingRef = useRef<{ path: string; content: string } | null>(
    null,
  );

  const flushAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const pending = autoSavePendingRef.current;
    autoSavePendingRef.current = null;
    if (!pending) return;
    try {
      await sqlWorkspaceTauri.writeFile(pending.path, pending.content);
      dispatch({ type: "mark-clean", path: pending.path });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("auto-save failed", formatError(err));
    }
  }, [dispatch]);

  const handleEditorChange = useCallback(
    (next: string) => {
      if (!selectedPath) return;
      dispatch({
        type: "set-buffer",
        path: selectedPath,
        content: next,
        dirty: true,
      });
      // Re-arm the trailing-edge debounce. The pending ref always
      // holds the freshest content, so when the timer eventually
      // fires (or `flushAutoSave` is called), the latest typed
      // bytes hit disk.
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      autoSavePendingRef.current = { path: selectedPath, content: next };
      autoSaveTimerRef.current = setTimeout(() => {
        autoSaveTimerRef.current = null;
        void flushAutoSave();
      }, 1000);
    },
    [selectedPath, dispatch, flushAutoSave],
  );

  const handleSave = useCallback(
    async (next: string) => {
      if (!selectedPath) return;
      // Manual ⌘S beats the timer to the punch — cancel anything
      // pending so we don't double-write.
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      autoSavePendingRef.current = null;
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

  // Force-flush pending save when the user switches files or the
  // pane unmounts — otherwise the last edits to file A would be
  // discarded the moment the user clicks file B.
  useEffect(() => {
    return () => {
      void flushAutoSave();
    };
  }, [selectedPath, flushAutoSave]);

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
  const handleRun = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    if (selection.trim().length > 0) {
      runQuery(activeId, selection, ctxOpts);
      return;
    }
    const buffer = editor.getValue();
    const cursor = editor.getCursorOffset();
    const stmt = statementAtCursor(buffer, cursor);
    if (!stmt) return;
    runQuery(activeId, stmt.sql, ctxOpts);
  }, [activeId, runQuery, ctxOpts]);

  /** Explicit "run every statement in the buffer". */
  const handleRunAll = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const buffer = editor.getValue();
    if (buffer.trim().length === 0) return;
    runQuery(activeId, buffer, ctxOpts);
  }, [activeId, runQuery, ctxOpts]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden">
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
