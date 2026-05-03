/**
 * Top-level layout for the Database Explorer (post-revamp):
 *
 *   ┌──────────────┬──────────────────────────────┬────────────────┐
 *   │ SQL Files    │ Connection tabs   [+Manage]  │ Cache badge    │
 *   │ (project     ├──────────────────────────────┤ + DB tree      │
 *   │  tree)       │ Run toolbar                  │  (schema       │
 *   │              ├──────────────────────────────┤   browser)     │
 *   │              │ Editor tab strip (open files)│                │
 *   │              ├──────────────────────────────┤                │
 *   │              │ SQL editor                   │                │
 *   │              ├──────────────────────────────┤                │
 *   │              │ Results grid                 │                │
 *   │              ├──────────────────────────────┤                │
 *   │              │ Status bar (conn · file)     │                │
 *   └──────────────┴──────────────────────────────┴────────────────┘
 *
 * Six clearly-tiered horizontal surfaces in the centre column:
 * connection tabs (deep) → toolbar (raised) → editor tabs (deep) →
 * editor (raised) → result tabs (deep) → results (raised) → status
 * bar (chrome). The eye finds seams between zones at a glance — the
 * old "everything is bg-muted/30" smear is gone.
 *
 * - **Left**: project folders + their `.sql` files.
 * - **Centre**: connection tabs (with +Manage popover), Run
 *   toolbar (action-only), editor-tab strip naming the open file,
 *   SQL editor, results, status bar pinning connection identity +
 *   open-file path.
 * - **Right**: schema browser only — connection management lives
 *   in the +Manage popover up top, not in this rail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CacheStatusBadge } from "./components/cache-status-badge";
import { ConnectionForm } from "./components/connection-form";
import { ConnectionTabs } from "./components/connection-tabs";
import { DbTree } from "./components/db-tree";
import { EditorTabStrip } from "./components/editor-tab-strip";
import { SqlFileTree } from "./components/sql-file-tree";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@zen-tools/ui";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import {
  SqlEditor,
  type SqlEditorHandle,
} from "./components/sql-editor";
import { SchemaProgressIndicator } from "./components/schema-progress-indicator";
import { RunToolbar, type RunModes } from "./components/run-toolbar";
import { ResultsPane } from "./components/results-pane";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery } from "./hooks/use-db-query";
import { useSqlProjectsBootstrap } from "./hooks/use-sql-workspace";
import { dbTauri, sqlWorkspaceTauri, type SqlFileTreeItem } from "./lib/tauri";
import { formatError } from "./lib/format-error";
import { splitStatements, statementAtCursor } from "./lib/sql-statements";
import { ensureTablesForSql } from "./lib/schema-cache";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useShortcut } from "@zen-tools/keyboard";
import { useVimMode } from "@/hooks/use-vim-mode";

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
      // `open-file` is the post-revamp door: it appends the file to
      // `state.openFilePaths` (if not already present) AND sets
      // `selectedFilePath`. The editor tab strip reads from that
      // list. Old `select-file` only flipped the active path,
      // which now means "I want to look at this buffer without
      // surfacing it as a tab" — keep it for programmatic
      // close-fallback in the reducer; UI callers should hit
      // `open-file`.
      dispatch({ type: "open-file", path: item.path });
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

  /** Whether auto-EXPLAIN is on for the active connection — drives
   * the toolbar pill + the piggyback in `handleRun`. */
  const autoExplain = activeId
    ? state.autoExplainByConnection[activeId] ?? false
    : false;

  /** Whether "Run with plan" runs `EXPLAIN ANALYZE` (executes the
   * query, gathers actuals/timing/buffers) or plan-only `EXPLAIN`
   * (estimates, no execution — safe for destructive statements).
   * Default `true` matches the original behaviour for users who
   * never touch the toolbar checkbox. */
  const analyzeOnExplain = activeId
    ? state.analyzeOnExplainByConnection[activeId] ?? true
    : true;

  /** Loose detection — DDL doesn't ANALYZE cleanly so we skip the
   * auto-EXPLAIN piggyback for it. The user can still hit "Run with
   * plan" deliberately. */
  const isAnalyzableSql = useCallback((sqlText: string): boolean => {
    const head = sqlText.trim().toUpperCase();
    if (!head) return false;
    return (
      head.startsWith("SELECT") ||
      head.startsWith("WITH") ||
      head.startsWith("INSERT") ||
      head.startsWith("UPDATE") ||
      head.startsWith("DELETE") ||
      head.startsWith("VALUES") ||
      head.startsWith("TABLE")
    );
  }, []);

  /**
   * Fire `db_explain_query` for `sqlText` and route the result.
   *
   * `mode: "replace"` (Run with plan) — calls `set-results` so the
   * plan tab opens fresh, replacing any previous run's tabs.
   *
   * `mode: "append"` (Auto-EXPLAIN piggyback) — calls
   * `append-result` so the plan tab lands next to the data tab
   * `runQuery` just produced.
   *
   * Errors are surfaced to the toolbar via `set-error` (cleared on
   * the next successful Run) so the user knows when EXPLAIN failed —
   * the most common cause is a multi-statement / DDL input that
   * Postgres won't EXPLAIN.
   */
  const captureExplain = useCallback(
    async (
      sqlText: string,
      // Routing for the resulting plan + how loud to be on failure:
      //
      //   • `"replace"`         — explicit "Plan only" run
      //                            (locks not selected). Replaces the
      //                            result set with the plan tab and
      //                            surfaces failures as a full error
      //                            card.
      //   • `"append-explicit"` — explicit "Plan + Locks" combo from
      //                            the dropdown. User asked for both,
      //                            so we append a plan tab next to
      //                            the data tab AND auto-switch to it
      //                            so the flamegraph is visible
      //                            without an extra click. Failures
      //                            surface visibly via the toolbar's
      //                            red one-liner — silent failure
      //                            here was the bug behind "I picked
      //                            all options and saw no plan".
      //   • `"append-silent"`   — auto-EXPLAIN piggyback fired by a
      //                            regular Run. The user didn't ask
      //                            for the plan explicitly; failures
      //                            are logged only so a bad EXPLAIN
      //                            doesn't clobber a good data tab.
      mode: "replace" | "append-explicit" | "append-silent",
      // Auto-EXPLAIN piggyback runs *after* the user's data has
      // already been computed by `runQuery`, so re-running with
      // ANALYZE just to capture a plan would double-execute. We
      // default piggybacks to `analyze: false` (plan-only). The
      // explicit "Run with plan" path still respects the toolbar
      // checkbox (which defaults to `true`).
      analyze: boolean,
    ) => {
      if (!activeId) return;
      try {
        const explain = await dbTauri.explainQuery(activeId, sqlText, {
          ...ctxOpts,
          analyze,
        });
        if (mode === "replace") {
          dispatch({
            type: "set-results",
            id: activeId,
            results: [{ kind: "explain", explain }],
          });
          dispatch({ type: "set-error", id: activeId, error: null });
        } else {
          // Append-* paths: add as a sibling tab. For the
          // explicit case (user picked Plan + Locks), the
          // reducer also flips the active index atomically so
          // the flamegraph is immediately visible — earlier we
          // tried this with a follow-up dispatch and reading
          // `state.resultsByConnection`, but that closure value
          // goes stale across the await and we'd land on the
          // wrong tab.
          dispatch({
            type: "append-result",
            id: activeId,
            tab: { kind: "explain", explain },
            activate: mode === "append-explicit",
          });
        }
        dispatch({
          type: "push-explain-history",
          id: activeId,
          explain,
        });
      } catch (err) {
        const message = formatError(err);
        if (mode === "replace" || mode === "append-explicit") {
          // User explicitly asked for a plan — make the failure
          // visible. For `replace` we wipe the tabs (there's
          // nothing else to show); for `append-explicit` we
          // KEEP the data tab the user just got and surface the
          // plan failure in the toolbar's error one-liner so
          // they know *why* the plan tab didn't appear.
          dispatch({
            type: "set-error",
            id: activeId,
            error: `EXPLAIN failed: ${message}`,
          });
          if (mode === "replace") {
            dispatch({
              type: "set-results",
              id: activeId,
              results: null,
            });
          }
        } else {
          // Auto-EXPLAIN piggyback failure — log only; the user
          // got their data tab, no need to clobber it with a
          // plan error they didn't ask for.
          // eslint-disable-next-line no-console
          console.warn("auto-EXPLAIN failed", message);
        }
      }
    },
    [activeId, ctxOpts, dispatch],
  );

  /**
   * Cursor / selection target shared by `handleRun` and
   * `handleRunWithPlan`. Returns the SQL the user actually wants to
   * run + a tag of how we resolved it. Falls back to the
   * statement-at-cursor when there's no selection.
   */
  const resolveTarget = useCallback((): { sql: string } | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const selection = editor.getSelection();
    if (selection.trim().length > 0) {
      return { sql: selection };
    }
    const buffer = editor.getValue();
    const cursor = editor.getCursorOffset();
    const stmt = statementAtCursor(buffer, cursor);
    return stmt ? { sql: stmt.sql } : null;
  }, []);

  const handleRun = useCallback(async () => {
    if (!activeId) return;
    const target = resolveTarget();
    if (!target) return;
    ensureCacheForSql(target.sql);
    // **Awaited** so the auto-EXPLAIN piggyback runs strictly after
    // the data result is already in place. Without this chain a
    // fast EXPLAIN could resolve before the slow data query and
    // get clobbered by the data's `set-results`.
    await runQuery(activeId, target.sql, ctxOpts);
    if (autoExplain && isAnalyzableSql(target.sql)) {
      // Plan-only on the piggyback path: we just executed the user's
      // SQL via `runQuery`, doing it again with ANALYZE for a plan
      // is double-work and (worse) double-side-effects on DML.
      // `append-silent` so a flaky EXPLAIN doesn't clobber a good
      // data tab with a scary error — auto-EXPLAIN is a sticky
      // toggle, the user didn't ask for *this* particular run.
      void captureExplain(target.sql, "append-silent", false);
    }
  }, [
    activeId,
    runQuery,
    ctxOpts,
    ensureCacheForSql,
    autoExplain,
    captureExplain,
    isAnalyzableSql,
    resolveTarget,
  ]);

  /** Explicit "run every statement in the buffer". Auto-EXPLAIN is
   * deliberately skipped here — Postgres EXPLAIN doesn't accept
   * multi-statement input, and DDL among the statements would
   * surface a confusing error. The user can still click "Run with
   * plan" on a single statement after Run All. */
  const handleRunAll = useCallback(() => {
    if (!activeId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const buffer = editor.getValue();
    if (buffer.trim().length === 0) return;
    ensureCacheForSql(buffer);
    runQuery(activeId, buffer, ctxOpts);
  }, [activeId, runQuery, ctxOpts, ensureCacheForSql]);

  /**
   * Explicit "Run with plan" — drives the perf visualizer. Uses the
   * same target shape as `handleRun` (selection > cursor statement)
   * and routes through `db_explain_query` in `replace` mode so the
   * plan tab is the first / only result tab in the pane.
   *
   * Important: on Postgres, EXPLAIN ANALYZE doesn't ship the
   * inner query's rows — only the plan. If you need the data
   * alongside, enable Auto-EXPLAIN and click Run instead.
   */
  /**
   * Selected modes for the toolbar's "Run with…" multi-select.
   * Persisted per-connection in the store so the user keeps their
   * combo (e.g. "Plan + Locks") across editor focus changes.
   * `actuals` lives in `analyzeOnExplain` (legacy slice — drives
   * the auto-EXPLAIN piggyback too) and gets stitched in here.
   */
  const runModesSel = activeId
    ? state.runModesByConnection[activeId] ?? { plan: false, locks: false }
    : { plan: false, locks: false };
  const runModes: RunModes = {
    plan: runModesSel.plan,
    locks: runModesSel.locks,
    actuals: analyzeOnExplain,
  };
  const handleChangeRunModes = useCallback(
    (next: RunModes) => {
      if (!activeId) return;
      // Split: `plan` + `locks` go into the dropdown slice;
      // `actuals` rides on the legacy `analyzeOnExplain` flag so
      // the auto-EXPLAIN piggyback path keeps reading the same
      // source of truth.
      dispatch({
        type: "set-run-modes",
        id: activeId,
        modes: { plan: next.plan, locks: next.locks },
      });
      if (next.actuals !== analyzeOnExplain) {
        dispatch({
          type: "set-analyze-on-explain",
          id: activeId,
          enabled: next.actuals,
        });
      }
    },
    [activeId, analyzeOnExplain, dispatch],
  );

  /**
   * Combined "Run with…" handler. Fires whatever modes the user
   * has checked in the dropdown, in parallel where possible:
   *
   *   • locks=true                       → `db_query` with
   *                                        `captureLocks` so each
   *                                        result tab gains a
   *                                        Locks sub-tab.
   *   • plan=true (alone)                → `db_explain_query` in
   *                                        `replace` mode — opens
   *                                        the perf visualizer in
   *                                        place of the data grid.
   *   • plan=true AND locks=true         → run the query for data
   *                                        with locks AND fire an
   *                                        EXPLAIN piggyback that
   *                                        appends a plan tab next
   *                                        to it.
   *   • actuals (only with plan)         → toggles
   *                                        `EXPLAIN ANALYZE` vs
   *                                        plain `EXPLAIN`.
   *   • all flags off                    → no-op (the dropdown
   *                                        button is disabled
   *                                        upstream when this
   *                                        happens).
   */
  const handleRunWithModes = useCallback(
    async (modes: RunModes) => {
      if (!activeId) return;
      const target = resolveTarget();
      if (!target) return;
      ensureCacheForSql(target.sql);

      const wantsData = modes.locks; // need data tab to host the Locks sub-tab
      const wantsPlanOnly = modes.plan && !modes.locks;

      if (wantsPlanOnly) {
        // Plan with no data side — replace the result set with the
        // plan tab. Mirrors the original "Run with plan" path.
        void captureExplain(target.sql, "replace", modes.actuals);
        return;
      }

      if (wantsData) {
        // Run the query for data (with optional lock telemetry),
        // then if the user also wants a plan, fire the piggyback
        // and append it as a sibling tab.
        await runQuery(activeId, target.sql, {
          ...ctxOpts,
          captureLocks: modes.locks,
        });
        if (modes.plan) {
          // **Explicit** Plan + Locks combo from the dropdown.
          //
          // Multi-statement input gotcha: Postgres `EXPLAIN`
          // (and MSSQL `SHOWPLAN_XML`) only accept a single
          // statement as the body. If the user dragged-selected
          // a transaction block like
          // `BEGIN; CREATE INDEX ...; pg_sleep(...); ROLLBACK;`
          // the data + locks path runs all of it as a batch
          // (locks attach per-statement), but the explain path
          // chokes with `syntax error at or near "BEGIN"`.
          //
          // Pick the most-interesting statement out of the
          // selection and EXPLAIN that one. Heuristic:
          //   • Skip transaction control + session-state +
          //     waiting statements (BEGIN, COMMIT, ROLLBACK,
          //     SET, SAVEPOINT, WAITFOR, SELECT pg_sleep(…)).
          //   • Take the first statement that survives.
          //   • If nothing survives (the entire selection is
          //     control statements), skip Plan with a soft
          //     toolbar note — running EXPLAIN would only
          //     surface a syntax error.
          const planTarget = pickPlanTarget(target.sql);
          if (planTarget) {
            void captureExplain(planTarget, "append-explicit", modes.actuals);
          } else {
            dispatch({
              type: "set-error",
              id: activeId,
              error:
                "Plan skipped: selection has no statement EXPLAIN can profile (only BEGIN/COMMIT/ROLLBACK/SET/sleep statements were selected).",
            });
          }
        }
      }
    },
    [
      activeId,
      runQuery,
      ctxOpts,
      ensureCacheForSql,
      resolveTarget,
      captureExplain,
      dispatch,
    ],
  );

  /**
   * Cmd+W / Ctrl+W — close the active result tab.
   *
   * Only registered when there's at least one result tab to close;
   * otherwise the chord falls through to the OS default (which on
   * macOS/Tauri closes the window). `fireInInputs: true` so the
   * shortcut still works when the user's cursor is parked in the
   * SQL editor — that's where they almost always are when they
   * want to dismiss the last result.
   */
  const closeActiveResultTab = useCallback(() => {
    if (!activeId) return;
    const tabs = state.resultsByConnection[activeId];
    if (!tabs || tabs.length === 0) return;
    const idx = Math.min(
      state.activeResultIndexByConnection[activeId] ?? 0,
      tabs.length - 1,
    );
    dispatch({ type: "close-result-tab", id: activeId, index: idx });
  }, [activeId, state.resultsByConnection, state.activeResultIndexByConnection, dispatch]);
  useShortcut(
    "mod+w",
    closeActiveResultTab,
    !!(activeId && (state.resultsByConnection[activeId]?.length ?? 0) > 0),
    { fireInInputs: true },
  );

  const handleToggleAutoExplain = useCallback(() => {
    if (!activeId) return;
    dispatch({
      type: "set-auto-explain",
      id: activeId,
      enabled: !autoExplain,
    });
  }, [activeId, autoExplain, dispatch]);


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
          onRunWithModes={handleRunWithModes}
          runModes={runModes}
          onChangeRunModes={handleChangeRunModes}
          autoExplain={autoExplain}
          onToggleAutoExplain={handleToggleAutoExplain}
        />
        {/* Editor-tab strip — the most prominent "what file am I
            looking at?" affordance. Sits between the toolbar
            (raised, action-coloured) and the editor body so it
            visually anchors the editor to its file. Hidden when
            no files are open; the empty-editor state takes over. */}
        <EditorTabStrip />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!resultsMaximized && (
            <>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden border-b border-border/60">
                {selectedPath ? (
                  <SqlEditor
                    key={selectedPath}
                    imperativeRef={editorRef}
                    driver={active?.driver ?? "postgres"}
                    // Gate connection-aware features on the live
                    // status. Without this, the editor's eager
                    // catalog + column prefetch fires the moment
                    // the user picks a saved connection — racing
                    // `db_connect` and producing a stack of
                    // "connection not found" progress chips. The
                    // editor still mounts (so the user can type),
                    // it just runs in keywords-only mode until the
                    // connection actually comes online.
                    connectionId={isConnected ? activeId : null}
                    database={isConnected ? activeDatabase : null}
                    schema={isConnected ? activeSchema : null}
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
              error={error}
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
            title="Show Schema"
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
          {/* Right rail post-revamp: schema browser only.
              ConnectionList moved into the +Manage popover spawned
              from the connection-tab strip; the rail no longer
              splits its vertical space three ways. */}
          <aside
            className="flex shrink-0 flex-col border-l border-border/60 bg-muted/40"
            style={{ width: rightWidth }}
          >
            {/* Header strip: "Schema" label + collapse-rail button.
                Replaces the ConnectionList header that used to sit
                here and own the rail's identity. */}
            <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>Schema</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                onClick={() => setRightCollapsed(true)}
                title="Collapse panel"
              >
                <PanelRightOpen className="size-3 rotate-180" />
              </Button>
            </div>
            {/* Schema-cache status — pinned above the DB tree as a
                fixed place to read "X/Y tables indexed" and watch
                live indexing progress. Hides when no connection is
                live. */}
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

/**
 * Pick the single most-interesting statement out of a multi-statement
 * selection for the EXPLAIN piggyback.
 *
 * Postgres `EXPLAIN` and MSSQL `SHOWPLAN_XML` only accept one
 * statement as the body. When the user dragged-selected a transaction
 * block (`BEGIN; …; ROLLBACK;`), passing the whole thing to the
 * explain path errors with `syntax error at or near "BEGIN"`.
 *
 * The heuristic:
 *   1. Tokenize on `;` using the existing `splitStatements` (same
 *      rules the backend uses, so what we pick will round-trip).
 *   2. Drop transaction-control + session-state + waiting statements
 *      that EXPLAIN either refuses or finds uninteresting (they have
 *      no plan to surface).
 *   3. Take the first remaining statement. Picking the *first* user
 *      statement matches what people usually want — the lead query
 *      that actually does work, before the WAITFOR/sleep that's just
 *      there to give the lock sampler a window.
 *
 * Returns `null` when nothing survives (the entire selection is
 * control/sleep statements). Caller should skip Plan rather than
 * fire EXPLAIN against junk.
 */
function pickPlanTarget(sql: string): string | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;
  // Single-statement input: pass through unchanged. Common case.
  if (stmts.length === 1) return stmts[0].sql;

  // Skip patterns. Match against the first ~80 chars uppercased so
  // we catch `BEGIN`, `BEGIN TRAN`, `BEGIN TRANSACTION ISOLATION
  // LEVEL …`, etc. without writing a real parser. The list covers
  // both PG and MSSQL dialects so this helper is engine-agnostic.
  const skipRegex =
    /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END(?:\s+TRAN)?|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|SET|USE|WAITFOR|DECLARE|GO)\b/i;
  // pg_sleep is wrapped in SELECT — has to be matched on body.
  const sleepRegex = /^\s*SELECT\s+pg_sleep\s*\(/i;

  for (const s of stmts) {
    if (skipRegex.test(s.sql)) continue;
    if (sleepRegex.test(s.sql)) continue;
    return s.sql;
  }
  return null;
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

// `FileFooter` was removed — its job (file path + dirty marker)
// moved into the new `StatusBar` component so connection identity
// and file context share one well-tiered chrome strip.
