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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SplitLayout,
  leafIds,
  useJumpList,
  useSplitWorkspace,
  useWorkspaceVim,
  type JumpEntry,
  type WorkspaceContext,
} from "@zen-tools/editor";
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
import { PlaceholderDialog } from "./components/placeholder-dialog";
import { useDbExplorerStore } from "./store/db-explorer-store";
import { useDbQuery, makeQueryId } from "./hooks/use-db-query";
import { useSqlProjectsBootstrap } from "./hooks/use-sql-workspace";
import {
  dbTauri,
  sqlWorkspaceTauri,
  type DbDriverId,
  type SqlFileTreeItem,
} from "./lib/tauri";
import { formatError } from "./lib/format-error";
import { splitStatements, statementAtCursor } from "./lib/sql-statements";
import {
  extractPlaceholders,
  substitutePlaceholders,
  uniqueNames,
} from "./lib/sql-placeholders";
import { ensureTablesForSql } from "./lib/schema-cache";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useShortcut } from "@zen-tools/keyboard";
import { useVimMode } from "@/hooks/use-vim-mode";

export function DatabaseExplorerView() {
  useSqlProjectsBootstrap();

  const { state, dispatch } = useDbExplorerStore();
  const { runQuery } = useDbQuery();
  const { vimMode } = useVimMode();
  const workspace = useSplitWorkspace();
  const jumpList = useJumpList();
  // One handle per split leaf. Run / EXPLAIN flows read from the
  // *focused* leaf so the user's selection / cursor in that split
  // drives execution.
  const leafHandlesRef = useRef<Map<string, SqlEditorHandle>>(new Map());
  const focusedHandle = useCallback(
    () => leafHandlesRef.current.get(workspace.focusedLeafId) ?? null,
    [workspace.focusedLeafId],
  );

  // Per-leaf selected file path — different splits can show different
  // SQL files. The store's `state.selectedFilePath` slaves to the
  // focused leaf's path so file tree / tab strip / run flow keep
  // working unchanged.
  const [leafPaths, setLeafPaths] = useState<Record<string, string>>({});
  const prevFocusedLeafRef = useRef(workspace.focusedLeafId);

  // Effect A — focus change syncs `state.selectedFilePath` to the
  // new focused leaf's stored path. New (just-split) leaves with
  // no stored path inherit from the previously-focused leaf.
  useEffect(() => {
    const newFocused = workspace.focusedLeafId;
    const oldFocused = prevFocusedLeafRef.current;
    prevFocusedLeafRef.current = newFocused;
    if (newFocused === oldFocused) return;
    setLeafPaths((prev) => {
      const stored = prev[newFocused];
      if (stored) {
        if (stored !== state.selectedFilePath) {
          dispatch({ type: "select-file", path: stored });
        }
        return prev;
      }
      const inherited = prev[oldFocused] ?? state.selectedFilePath;
      if (!inherited) return prev;
      return { ...prev, [newFocused]: inherited };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.focusedLeafId]);

  // Effect B — `state.selectedFilePath` changes (sidebar click,
  // tab strip click) update the focused leaf's stored path.
  useEffect(() => {
    if (!state.selectedFilePath) return;
    setLeafPaths((prev) => {
      if (prev[workspace.focusedLeafId] === state.selectedFilePath) return prev;
      return {
        ...prev,
        [workspace.focusedLeafId]: state.selectedFilePath!,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedFilePath]);

  // Effect C — prune entries for leaves that no longer exist.
  useEffect(() => {
    const valid = new Set(leafIds(workspace.tree));
    setLeafPaths((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (valid.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [workspace.tree]);

  const pathForLeaf = useCallback(
    (leafId: string) => leafPaths[leafId] ?? state.selectedFilePath ?? null,
    [leafPaths, state.selectedFilePath],
  );

  // ── Deterministic per-leaf dispatch (same shape as MarkdownView) ──
  // `leafPathsRef` is synced *synchronously* in `useLayoutEffect`,
  // so any keystroke arriving between commit and useEffect (the
  // window where regular ref-update effects haven't fired yet) sees
  // an up-to-date map. The change/save callbacks are deliberately
  // stable so `CodeEditor`'s internal `onChangeRef` / `onSaveRef`
  // captured at mount never go stale — the lookup happens at fire
  // time using the *current* ref value, not a captured prop.
  const leafPathsRef = useRef(leafPaths);
  const selectedFilePathRef = useRef(state.selectedFilePath);
  useLayoutEffect(() => {
    leafPathsRef.current = leafPaths;
    selectedFilePathRef.current = state.selectedFilePath;
  });
  const onLeafEditorChange = useCallback(
    (leafId: string, next: string) => {
      const path =
        leafPathsRef.current[leafId] ?? selectedFilePathRef.current;
      if (!path) return;
      dispatch({ type: "set-buffer", path, content: next, dirty: true });
    },
    [dispatch],
  );
  // (`onLeafEditorSave` is declared further down, after `autoSave`
  // is initialised — it needs `autoSave.cancel` to short-circuit
  // the trailing-edge debounce on ⌘S.)

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

  // Active `:name` placeholder prompt. `null` means the dialog is
  // closed. The promise resolvers are stashed here so a single
  // `resolvePlaceholders(sql)` call can `await` the user's answer
  // and route the substituted SQL back through any of the three run
  // paths (Run, Run all, Run with…).
  const [placeholderPrompt, setPlaceholderPrompt] = useState<{
    names: string[];
    seed: Record<string, string>;
    resolve: (values: Record<string, string> | null) => void;
  } | null>(null);

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

  // Load file content for *every* leaf path that hasn't been
  // hydrated yet — covers the "leaf B has its own path P that
  // hasn't been loaded" case. Re-clicking a dirty file doesn't
  // lose unsaved edits because `bufferByPath[path]` is checked
  // first.
  useEffect(() => {
    const seen = new Set<string>();
    const pathsToLoad: string[] = [];
    if (selectedPath && !seen.has(selectedPath)) {
      seen.add(selectedPath);
      if (state.bufferByPath[selectedPath] === undefined) {
        pathsToLoad.push(selectedPath);
      }
    }
    for (const p of Object.values(leafPaths)) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (state.bufferByPath[p] === undefined) pathsToLoad.push(p);
    }
    if (pathsToLoad.length === 0) return;

    let cancelled = false;
    void (async () => {
      for (const path of pathsToLoad) {
        try {
          const content = await sqlWorkspaceTauri.readFile(path);
          if (cancelled) return;
          dispatch({ type: "set-buffer", path, content, dirty: false });
        } catch (err) {
          if (!cancelled) {
            // eslint-disable-next-line no-console
            console.error("read file failed", formatError(err));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, leafPaths]);

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

  // Leaf-keyed save — race-free counterpart to `onLeafEditorChange`.
  // The legacy `handleSave` keyed on `state.selectedFilePath` was
  // removed; lookups go through `leafPathsRef` so a ⌘S during a
  // focus transition can't write the focused editor's content into
  // the previously-focused leaf's path.
  const autoSaveCancel = autoSave.cancel;
  const onLeafEditorSave = useCallback(
    async (leafId: string, next: string) => {
      const path =
        leafPathsRef.current[leafId] ?? selectedFilePathRef.current;
      if (!path) return;
      autoSaveCancel();
      try {
        await sqlWorkspaceTauri.writeFile(path, next);
        dispatch({ type: "mark-clean", path });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("write file failed", formatError(err));
      }
    },
    [autoSaveCancel, dispatch],
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
      const explainTabId = makeQueryId();
      const explainStarted = Date.now();
      const explainPreview = sqlText.replace(/\s+/g, " ").trim().slice(0, 120);
      try {
        const explain = await dbTauri.explainQuery(activeId, sqlText, {
          ...ctxOpts,
          analyze,
        });
        if (mode === "replace") {
          dispatch({
            type: "set-results",
            id: activeId,
            results: [
              {
                id: explainTabId,
                startedAt: explainStarted,
                status: "ok",
                sqlPreview: explainPreview,
                kind: "explain",
                explain,
              },
            ],
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
            tab: {
              id: explainTabId,
              startedAt: explainStarted,
              status: "ok",
              sqlPreview: explainPreview,
              kind: "explain",
              explain,
            },
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
   * If `sqlText` contains `:name` placeholders, open the prompt
   * dialog and resolve once the user submits or cancels. The
   * returned promise yields the substituted SQL (verbatim
   * substitution, no quoting) or `null` when the user cancels.
   *
   * Zero-overhead fast path: queries with no placeholders skip the
   * dialog entirely and resolve synchronously to the original SQL.
   *
   * Submitted values are persisted to the connection's session
   * memory (`placeholderValuesByConnection`) so the next run of the
   * same query opens the dialog with everything pre-filled.
   */
  const resolvePlaceholders = useCallback(
    (sqlText: string): Promise<string | null> => {
      if (!activeId) return Promise.resolve(sqlText);
      const occurrences = extractPlaceholders(sqlText);
      if (occurrences.length === 0) return Promise.resolve(sqlText);

      const names = uniqueNames(occurrences);
      const remembered =
        state.placeholderValuesByConnection[activeId] ?? {};
      // Seed with whatever we remember; missing names start empty.
      // Object spread is safe here (the dialog doesn't mutate).
      const seed: Record<string, string> = {};
      for (const name of names) {
        seed[name] = remembered[name] ?? "";
      }

      return new Promise<string | null>((resolve) => {
        setPlaceholderPrompt({
          names,
          seed,
          resolve: (values) => {
            // Close the dialog regardless of submit/cancel.
            setPlaceholderPrompt(null);
            // Restore editor focus once Radix has finished its
            // close transition (it manages focus internally during
            // unmount). A 0ms timeout drops us onto the next macro-
            // task, which is after Radix's blur-the-trigger logic
            // settles. Without this, the user has to click back
            // into the editor to keep typing — the original bug
            // report. With split workspaces we route to the focused
            // leaf's handle so focus lands on the split that fired
            // the run.
            window.setTimeout(() => focusedHandle()?.focus(), 0);
            if (!values) {
              resolve(null);
              return;
            }
            // Persist the user's answers for next time.
            dispatch({
              type: "set-placeholder-values",
              id: activeId,
              values,
            });
            try {
              resolve(substitutePlaceholders(sqlText, values));
            } catch (err) {
              // Should be unreachable — the dialog always returns
              // an entry for every name in `names`. If it ever
              // happens, surface as a normal toolbar error.
              dispatch({
                type: "set-error",
                id: activeId,
                error: formatError(err),
              });
              resolve(null);
            }
          },
        });
      });
    },
    [activeId, state.placeholderValuesByConnection, dispatch, focusedHandle],
  );

  /**
   * Cursor / selection target shared by `handleRun` and
   * `handleRunWithPlan`. Returns the SQL the user actually wants to
   * run + a tag of how we resolved it. Falls back to the
   * statement-at-cursor when there's no selection.
   */
  const resolveTarget = useCallback((): { sql: string } | null => {
    const editor = focusedHandle();
    if (!editor) return null;
    const selection = editor.getSelection();
    if (selection.trim().length > 0) {
      return { sql: selection };
    }
    const buffer = editor.getValue();
    const cursor = editor.getCursorOffset();
    const stmt = statementAtCursor(buffer, cursor);
    return stmt ? { sql: stmt.sql } : null;
  }, [focusedHandle]);

  const handleRun = useCallback(async () => {
    if (!activeId) return;
    const target = resolveTarget();
    if (!target) return;
    // Prompt for `:name` placeholders BEFORE the cache prefetch /
    // run. Cancelling out of the dialog returns `null` and aborts
    // — the user gets no cache thrash and no run from a half-typed
    // query. The substituted SQL is what flows through every
    // subsequent code path (data, auto-EXPLAIN piggyback, log).
    const finalSql = await resolvePlaceholders(target.sql);
    if (finalSql === null) return;
    ensureCacheForSql(finalSql);
    // **Awaited** so the auto-EXPLAIN piggyback runs strictly after
    // the data result is already in place. Without this chain a
    // fast EXPLAIN could resolve before the slow data query and
    // get clobbered by the data's `set-results`.
    await runQuery(activeId, finalSql, ctxOpts);
    if (autoExplain && isAnalyzableSql(finalSql)) {
      // Plan-only on the piggyback path: we just executed the user's
      // SQL via `runQuery`, doing it again with ANALYZE for a plan
      // is double-work and (worse) double-side-effects on DML.
      // `append-silent` so a flaky EXPLAIN doesn't clobber a good
      // data tab with a scary error — auto-EXPLAIN is a sticky
      // toggle, the user didn't ask for *this* particular run.
      void captureExplain(finalSql, "append-silent", false);
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
    resolvePlaceholders,
  ]);

  /** Explicit "run every statement in the buffer". Auto-EXPLAIN is
   * deliberately skipped here — Postgres EXPLAIN doesn't accept
   * multi-statement input, and DDL among the statements would
   * surface a confusing error. The user can still click "Run with
   * plan" on a single statement after Run All. */
  const handleRunAll = useCallback(async () => {
    if (!activeId) return;
    const editor = focusedHandle();
    if (!editor) return;
    const buffer = editor.getValue();
    if (buffer.trim().length === 0) return;
    // The full buffer may contain placeholders too — prompt once
    // for the union before running the whole batch.
    const finalSql = await resolvePlaceholders(buffer);
    if (finalSql === null) return;
    ensureCacheForSql(finalSql);
    runQuery(activeId, finalSql, ctxOpts);
  }, [
    activeId,
    runQuery,
    ctxOpts,
    ensureCacheForSql,
    resolvePlaceholders,
    focusedHandle,
  ]);

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
      // Single dialog covers the whole "Run with…" flow — both the
      // data path and the EXPLAIN piggyback receive the same
      // substituted SQL, so the user is prompted once even when
      // both Plan and Locks are checked.
      const finalSql = await resolvePlaceholders(target.sql);
      if (finalSql === null) return;
      ensureCacheForSql(finalSql);

      const wantsData = modes.locks; // need data tab to host the Locks sub-tab
      const wantsPlanOnly = modes.plan && !modes.locks;

      if (wantsPlanOnly) {
        // Plan with no data side — replace the result set with the
        // plan tab. Mirrors the original "Run with plan" path.
        void captureExplain(finalSql, "replace", modes.actuals);
        return;
      }

      if (wantsData) {
        // Run the query for data (with optional lock telemetry),
        // then if the user also wants a plan, fire the piggyback
        // and append it as a sibling tab.
        await runQuery(activeId, finalSql, {
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
          const planTarget = pickPlanTarget(finalSql);
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
      resolvePlaceholders,
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

  // Workspace bridge for `:q` / `:vsplit` / `:hsplit`. `:q` closes
  // the focused split when there are multiple; otherwise falls back
  // to closing the active editor tab — matching the rest of the
  // workspace.
  const workspaceContext = useMemo<WorkspaceContext>(
    () => ({
      closeActive: () => {
        if (workspace.closeFocused()) return;
        const path = state.selectedFilePath;
        if (path) dispatch({ type: "close-editor-tab", path });
      },
      split: (direction) => workspace.split(direction),
      moveFocus: (dir) => workspace.moveFocus(dir),
    }),
    [workspace, state.selectedFilePath, dispatch],
  );
  useWorkspaceVim(workspaceContext);

  // Push a jump entry on file switch or focused-leaf change so
  // `Ctrl+O`/`Ctrl+I` can step back through the user's sequence.
  useEffect(() => {
    if (!selectedPath) return;
    const handle = focusedHandle();
    jumpList.push({
      leafId: workspace.focusedLeafId,
      tabId: selectedPath,
      cursorOffset: handle?.getCursorOffset() ?? 0,
    });
  }, [selectedPath, workspace.focusedLeafId, jumpList, focusedHandle]);

  const navigateToJump = useCallback(
    (entry: JumpEntry | null): boolean => {
      if (!entry) return false;
      if (entry.tabId && entry.tabId !== state.selectedFilePath) {
        dispatch({ type: "select-file", path: entry.tabId });
      }
      if (entry.leafId !== workspace.focusedLeafId) {
        workspace.setFocus(entry.leafId);
      }
      requestAnimationFrame(() => {
        const handle = leafHandlesRef.current.get(entry.leafId);
        if (handle && entry.cursorOffset > 0) {
          const value = handle.getValue();
          const before = value.slice(0, entry.cursorOffset);
          handle.scrollToLine(before.split("\n").length);
        }
        handle?.focus();
      });
      return true;
    },
    [state.selectedFilePath, dispatch, workspace],
  );
  const onJumpBack = useCallback(
    () => navigateToJump(jumpList.back()),
    [jumpList, navigateToJump],
  );
  const onJumpForward = useCallback(
    () => navigateToJump(jumpList.forward()),
    [jumpList, navigateToJump],
  );


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
        {/* Editor-tab strip moved into each split leaf — every
            split now has its own tab rail, VS-Code style. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!resultsMaximized && (
            <>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden border-b border-border/60">
                {selectedPath ? (
                  // One CodeMirror per split leaf — each gets its
                  // own cursor / undo / scroll AND its own active
                  // file. The leaf renders the buffer keyed by its
                  // stored path; cross-leaf edits propagate through
                  // the store only when leaves point at the same
                  // path.
                  <SplitLayout
                    root={workspace.tree}
                    focusedLeafId={workspace.focusedLeafId}
                    onFocusLeaf={workspace.setFocus}
                    onResize={workspace.resize}
                    renderLeaf={(leafId, focused) => {
                      const leafPath = pathForLeaf(leafId);
                      const leafBuffer = leafPath
                        ? state.bufferByPath[leafPath] ?? ""
                        : "";
                      return (
                        <SqlLeafShell
                          // We deliberately do NOT key by leafPath
                          // here — the tab strip lives inside the
                          // leaf shell, so a leaf-internal tab
                          // switch can't be allowed to remount the
                          // whole shell (which would unmount the
                          // tab strip mid-click). Per-file CM state
                          // is instead reset by keying the inner
                          // SqlEditor on `leafPath` below.
                          key={leafId}
                          leafId={leafId}
                          leafPath={leafPath}
                          focused={focused}
                          driver={active?.driver ?? "postgres"}
                          connectionId={isConnected ? activeId : null}
                          database={isConnected ? activeDatabase : null}
                          schema={isConnected ? activeSchema : null}
                          openPaths={state.openFilePaths}
                          dirtyByPath={state.dirtyByPath}
                          initialValue={leafBuffer}
                          onSelectTab={(path) => {
                            // Click in this leaf's tab strip —
                            // focus this leaf AND swap its file.
                            workspace.setFocus(leafId);
                            setLeafPaths((prev) =>
                              prev[leafId] === path
                                ? prev
                                : { ...prev, [leafId]: path },
                            );
                            if (state.selectedFilePath !== path) {
                              dispatch({ type: "select-file", path });
                            }
                          }}
                          onCloseTab={(path) => {
                            dispatch({ type: "close-editor-tab", path });
                          }}
                          onChange={onLeafEditorChange}
                          onSave={onLeafEditorSave}
                          onRun={handleRun}
                          vimMode={vimMode}
                          onMoveFocus={workspace.moveFocus}
                          onJumpBack={onJumpBack}
                          onJumpForward={onJumpForward}
                          registerHandle={(h) => {
                            if (h) leafHandlesRef.current.set(leafId, h);
                            else leafHandlesRef.current.delete(leafId);
                          }}
                        />
                      );
                    }}
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

      {/* `:name` placeholder prompt. Mounted at the layout root so
          it overlays the entire view (including the right rail) and
          isn't clipped by any of the column-level `overflow-hidden`
          containers above. The dialog is fully controlled — its
          presence is gated on `placeholderPrompt`, and submit /
          cancel funnel back through the resolver passed in. */}
      <PlaceholderDialog
        prompt={
          placeholderPrompt
            ? {
                names: placeholderPrompt.names,
                seed: placeholderPrompt.seed,
              }
            : null
        }
        onSubmit={(values) => placeholderPrompt?.resolve(values)}
        onCancel={() => placeholderPrompt?.resolve(null)}
      />
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
 * One leaf of the SQL editor split workspace. Owns its own
 * `<SqlEditor>` (independent cursor / scroll / undo) showing this
 * leaf's `leafPath`. Multiple leaves pointed at the same path
 * converge through a `setValue` effect that watches `initialValue`
 * — the underlying CodeEditor's no-op guard prevents the
 * self-feedback loop when the leaf's own onChange dispatch comes
 * back round.
 */
interface SqlLeafShellProps {
  leafId: string;
  leafPath: string | null;
  focused: boolean;
  driver: DbDriverId;
  connectionId: string | null;
  database: string | null;
  schema: string | null;
  openPaths: string[];
  dirtyByPath: Record<string, boolean>;
  initialValue: string;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  /** `(leafId, doc) => void` — stable, leaf-keyed, deterministic. */
  onChange: (leafId: string, next: string) => void;
  /** `(leafId, doc) => void` — stable, leaf-keyed, deterministic. */
  onSave: (leafId: string, next: string) => Promise<void> | void;
  onRun: () => void;
  vimMode: boolean;
  onMoveFocus: (dir: "h" | "j" | "k" | "l") => void;
  onJumpBack: () => boolean;
  onJumpForward: () => boolean;
  registerHandle: (h: SqlEditorHandle | null) => void;
}

function SqlLeafShell({
  leafId,
  leafPath,
  focused,
  driver,
  connectionId,
  database,
  schema,
  openPaths,
  dirtyByPath,
  initialValue,
  onSelectTab,
  onCloseTab,
  onChange,
  onSave,
  onRun,
  vimMode,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  registerHandle,
}: SqlLeafShellProps) {
  const handleRef = useRef<SqlEditorHandle | null>(null);

  useEffect(() => {
    registerHandle(handleRef.current);
    return () => registerHandle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focused) handleRef.current?.focus();
  }, [focused]);

  // Cross-leaf convergence — when a sibling leaf editing the same
  // file types, the store updates and `initialValue` re-flows down
  // to us. CodeEditor's `setValue` no-op guard short-circuits when
  // we ourselves were the source of the change.
  useEffect(() => {
    handleRef.current?.setValue(initialValue);
  }, [initialValue]);

  // Stable `(doc) => void` wrappers around the parent's leaf-keyed
  // callbacks. Identity-stable across renders (deps are the stable
  // `leafId` prop + already-stable parent callbacks), so the
  // underlying CodeEditor's onChange/onSave refs captured at mount
  // never go stale.
  const handleEditorChange = useCallback(
    (next: string) => onChange(leafId, next),
    [leafId, onChange],
  );
  const handleEditorSave = useCallback(
    (next: string) => {
      void onSave(leafId, next);
    },
    [leafId, onSave],
  );

  return (
    <div
      className={
        focused
          ? "flex h-full w-full min-h-0 min-w-0 flex-col outline outline-1 outline-primary/40 -outline-offset-1"
          : "flex h-full w-full min-h-0 min-w-0 flex-col"
      }
    >
      <EditorTabStrip
        paths={openPaths}
        activePath={leafPath}
        dirtyByPath={dirtyByPath}
        onSelect={onSelectTab}
        onClose={onCloseTab}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <SqlEditor
          // Re-mount the inner editor per file so CodeMirror's
          // undo history doesn't bleed across files. The tab strip
          // sits OUTSIDE this re-keyed subtree so clicks on it
          // aren't interrupted by an unmount mid-event.
          key={leafPath ?? "empty"}
          imperativeRef={handleRef}
          driver={driver}
          connectionId={connectionId}
          database={database}
          schema={schema}
          value={initialValue}
          onChange={handleEditorChange}
          onSave={handleEditorSave}
          onRun={onRun}
          vimMode={vimMode}
          onMoveFocus={onMoveFocus}
          onJumpBack={onJumpBack}
          onJumpForward={onJumpForward}
        />
      </div>
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
