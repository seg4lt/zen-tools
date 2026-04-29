import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Download,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Square,
} from "lucide-react";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { HttpFileTree } from "./components/http-file-tree";
import { RequestList } from "./components/request-list";
import {
  HttpEditor,
  type HttpEditorHandle,
} from "./components/http-editor";
import { ResponsePanel } from "./components/response-panel";
import { PaneFrame, type PaneState } from "./components/pane-frame";
import { PerfTestList } from "./components/perf-test-list";
import { PerfDashboard } from "./components/perf-dashboard";
import { PerfSchemaSheet } from "./components/perf-schema-sheet";
import { usePerfRunner } from "./hooks/use-perf-runner";
import { onRequestChain, onRequestResult, tauri } from "./lib/tauri";
import { stableId, useHttpRunner } from "./store/http-runner-store";

/** `true` for `.perf.yaml` / `perf.yaml` / `perf.yml`. */
function isPerfFile(path: string | null): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".perf.yaml") ||
    lower.endsWith("/perf.yaml") ||
    lower.endsWith("/perf.yml") ||
    lower === "perf.yaml" ||
    lower === "perf.yml"
  );
}

/** Identifier for one of the four resizable panes. */
type PaneKey = "tree" | "list" | "editor" | "response";

/**
 * Three-pane layout: file tree | request list | (editor + response panel
 * stacked vertically). Streams `request:result` and `request:chain` events
 * from the Tauri backend into the reducer.
 *
 * Each pane has minimize / maximize / restore controls. When any pane is
 * maximized, the others are hidden and that pane fills the layout. When
 * a pane is collapsed it shrinks to a 32px strip showing only its
 * header.
 */
export function RequestsView() {
  const { state, dispatch } = useHttpRunner();
  const [treeWidth, setTreeWidth] = useState(220);
  const [listWidth, setListWidth] = useState(280);
  const [responseHeight, setResponseHeight] = useState(280);
  // Two orthogonal pieces of pane state:
  // - `collapsed[key]` toggles a 32px strip vs. the normal-sized pane.
  // - `maximizedPane` is exclusive: when set, only that pane renders
  //   full-bleed and the others are hidden. Restoring it leaves each
  //   pane's collapsed state intact (the previous coupled-state
  //   implementation reset every pane to "normal" on max/restore).
  const [collapsed, setCollapsed] = useState<Record<PaneKey, boolean>>({
    tree: false,
    list: false,
    editor: false,
    response: false,
  });
  const [maximizedPane, setMaximizedPane] = useState<PaneKey | null>(null);
  const queryClient = useQueryClient();
  const editorRef = useRef<HttpEditorHandle>(null);
  const [editorValue, setEditorValue] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  /** Pending debounced-save timer. */
  const saveTimerRef = useRef<number | null>(null);
  /** Latest editor content captured during typing. */
  const latestEditorRef = useRef<string>("");
  /**
   * `true` while we are programmatically pushing content into the editor
   * (e.g. after `rawContent` loads or a save round-trips). CodeMirror's
   * `updateListener` fires synchronously inside `setValue`, so without
   * this flag every file load would schedule a debounced auto-save of
   * the freshly-loaded file 600ms later — which felt like a "refresh".
   */
  const applyingExternalRef = useRef<boolean>(false);

  // ── pane layout helpers ────────────────────────────────────────────
  const toggleCollapse = (key: PaneKey) => {
    // If the user collapses the pane that is currently maximized, drop
    // out of max mode first so the rest of the layout reappears.
    if (maximizedPane === key) setMaximizedPane(null);
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleMaximize = (key: PaneKey) => {
    setMaximizedPane((prev) => (prev === key ? null : key));
  };

  const isMaximized = maximizedPane !== null;
  const maxKey = maximizedPane;

  /**
   * Translate the orthogonal `collapsed` + `maximizedPane` flags into
   * the tri-state PaneFrame still expects (`normal` / `collapsed` /
   * `maximized`).
   */
  const paneState = (key: PaneKey): PaneState =>
    maximizedPane === key
      ? "maximized"
      : collapsed[key]
        ? "collapsed"
        : "normal";

  // Width/height for a horizontally-arranged pane in the **normal**
  // (non-maximized) layout. Maximized panes bypass this helper because
  // the layout short-circuits to a single full-bleed pane.
  const horizontalSize = (
    key: PaneKey,
    nominal: number,
  ): React.CSSProperties => {
    if (collapsed[key]) return { width: 32, flex: "none" };
    return { width: nominal, flex: "none" };
  };
  // ───────────────────────────────────────────────────────────────────

  // Subscribe to streaming events once.
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onRequestResult((payload) => {
        dispatch({ type: "result", result: payload });
        if (payload.status.type === "running") {
          dispatch({ type: "setRunning", running: true });
        } else if (payload.status.type !== "idle") {
          dispatch({ type: "setRunning", running: false });
          // Newly extracted vars from this step affect downstream URL
          // previews — refetch the cached map.
          if (Object.keys(payload.extractedVars ?? {}).length > 0) {
            void queryClient.invalidateQueries({
              queryKey: ["extracted-vars"],
            });
          }
        }
        if (payload.logMessage) {
          dispatch({ type: "log", message: payload.logMessage });
        }
        // Surface errors and non-2xx responses in the logs panel — that
        // way the Logs button badge lights up red and clicking it shows
        // exactly what went wrong, instead of being empty when the
        // dependency-chain UI shows ✗.
        const label = payload.requestId.split(":").pop() ?? payload.requestId;
        if (payload.status.type === "error") {
          dispatch({
            type: "log",
            level: "error",
            message: `${label}: ${payload.status.message}`,
          });
        } else if (
          payload.status.type === "success" &&
          payload.status.response.statusCode >= 400
        ) {
          dispatch({
            type: "log",
            level: payload.status.response.statusCode >= 500 ? "error" : "warn",
            message: `${label}: HTTP ${payload.status.response.statusCode} ${payload.status.response.statusText}`,
          });
        }
      }),
      onRequestChain((payload) => {
        dispatch({ type: "chain", steps: payload.steps });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [dispatch, queryClient]);

  const isPerf = isPerfFile(state.selectedFilePath);

  // Only parse `.http`/`.rest` through the http parser. `.perf.yaml`
  // files are loaded as raw text + parsed via `loadPerfConfig` in the
  // perf-runner hook below.
  const { data: opened } = useQuery({
    queryKey: ["http-file", state.selectedFilePath],
    queryFn: () => tauri.openHttpFile(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null && !isPerf,
  });

  const { data: rawContent } = useQuery({
    queryKey: ["http-file-content", state.selectedFilePath],
    queryFn: () => tauri.readFileContent(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  const perf = usePerfRunner(isPerf ? state.selectedFilePath : null);

  // Env + extracted vars feed both the request-list URL preview and the
  // response panel "will hit" preview. Keyed off the active env so they
  // refetch when the user switches.
  const { data: envVars } = useQuery({
    queryKey: ["env-vars", state.activeEnv],
    queryFn: () => tauri.getEnvVars(),
    enabled: state.activeEnv !== null,
  });
  const { data: extractedVars } = useQuery({
    queryKey: ["extracted-vars", state.activeEnv],
    queryFn: () => tauri.getExtractedVars(),
  });

  useEffect(() => {
    if (opened && opened.file.path !== state.selectedFile?.path) {
      dispatch({
        type: "selectFile",
        path: opened.file.path,
        file: opened.file,
      });
      // Opening a file may have loaded a sibling `*.env.json` into
      // `local_env_file` on the backend, expanding the union of
      // available environment names. Invalidate so the EnvSelector
      // dropdown picks them up — without this the list stays whatever
      // it was when the env file's project was first added.
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
      void queryClient.invalidateQueries({ queryKey: ["env-vars"] });
    }
  }, [opened, state.selectedFile?.path, dispatch, queryClient]);

  useEffect(() => {
    if (rawContent !== undefined && rawContent !== null) {
      // Suppress the change listener while we push the freshly-loaded
      // content into CodeMirror — otherwise the synchronous
      // updateListener would schedule a spurious auto-save.
      applyingExternalRef.current = true;
      try {
        setEditorValue(rawContent);
        latestEditorRef.current = rawContent;
        editorRef.current?.setValue(rawContent);
        setIsDirty(false);
        // Cancel any pending save the previous file may have scheduled.
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      } finally {
        applyingExternalRef.current = false;
      }
    }
  }, [rawContent]);

  // Cancel any pending debounced save when the file or component changes.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [state.selectedFilePath]);

  useEffect(() => {
    if (!state.selectedRequestId || !state.selectedFile) return;
    const req = state.selectedFile.requests.find(
      (r) => stableId(state.selectedFile!.path, r) === state.selectedRequestId,
    );
    if (req) {
      editorRef.current?.scrollToLine(req.lineNumber);
    }
  }, [state.selectedRequestId, state.selectedFile]);

  const handleSave = useCallback(
    async (value: string) => {
      if (!state.selectedFilePath) return;
      try {
        await tauri.writeFileContent(state.selectedFilePath, value);
        // Only `.http`/`.rest` files go through the http parser. For
        // perf YAMLs we just invalidate the perf-config query so the
        // test list re-parses on the next render.
        if (isPerf) {
          await queryClient.invalidateQueries({
            queryKey: ["perf-config", state.selectedFilePath],
          });
        } else {
          const fresh = await tauri.reloadHttpFile(state.selectedFilePath);
          // Use updateParsedFile (not selectFile) so the editor cursor +
          // selected request are preserved across the save.
          dispatch({ type: "updateParsedFile", file: fresh.file });
        }
        // The editor is the source of truth for the live buffer, so we
        // bump editorValue (used as the dirty baseline) without pushing
        // the value back into CodeMirror — that would clobber the
        // user's cursor.
        setEditorValue(value);
        setIsDirty(false);
        // Keep the React Query cache in sync so other consumers
        // (re-mounts, refresh) get the new content on next access.
        queryClient.setQueryData(
          ["http-file-content", state.selectedFilePath],
          value,
        );
      } catch (err) {
        dispatch({
          type: "log",
          level: "error",
          message: `Save failed: ${(err as { message?: string }).message ?? err}`,
        });
      }
    },
    [dispatch, isPerf, queryClient, state.selectedFilePath],
  );

  /**
   * Called on every keystroke from the editor. Updates the dirty flag
   * for the title indicator and schedules a debounced auto-save 600ms
   * after the user stops typing. The save handler reparses + dispatches
   * `updateParsedFile`, so the request list and run-gutter stay in sync
   * with what's on screen.
   */
  const handleEditorChange = useCallback(
    (next: string) => {
      // Ignore changes that originated from us (loading a file, applying
      // a save). These are not user edits, so they must not flip the
      // dirty flag or schedule a save.
      if (applyingExternalRef.current) {
        latestEditorRef.current = next;
        return;
      }
      latestEditorRef.current = next;
      setIsDirty(next !== editorValue);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        if (latestEditorRef.current !== editorValue) {
          void handleSave(latestEditorRef.current);
        }
      }, 600);
    },
    [editorValue, handleSave],
  );

  const runRequest = useCallback(
    async (
      filePath: string,
      requestId: string,
      withDeps: boolean,
    ): Promise<void> => {
      // Optimistically flip the running flag + run-mode so the right
      // button shows a spinner immediately, before any event arrives.
      dispatch({
        type: "setRunning",
        running: true,
        mode: withDeps ? "withDeps" : "single",
      });
      try {
        if (withDeps) {
          await tauri.runRequestWithDeps(filePath, requestId);
        } else {
          await tauri.runRequest(filePath, requestId);
        }
      } catch (err) {
        dispatch({ type: "setRunning", running: false });
        dispatch({
          type: "log",
          level: "error",
          message: `Run failed: ${(err as { message?: string }).message ?? err}`,
        });
      }
    },
    [dispatch],
  );

  const handleRunLine = useCallback(
    (line: number, withDeps = false) => {
      if (!state.selectedFile) return;
      const sorted = [...state.selectedFile.requests].sort(
        (a, b) => a.lineNumber - b.lineNumber,
      );
      let match: (typeof sorted)[number] | null = null;
      for (const req of sorted) {
        if (req.lineNumber <= line) match = req;
        else break;
      }
      if (!match) {
        dispatch({
          type: "log",
          level: "warn",
          message: `No request found at line ${line}`,
        });
        return;
      }
      const id = stableId(state.selectedFile.path, match);
      dispatch({ type: "selectRequest", id });
      void runRequest(state.selectedFile.path, id, withDeps);
    },
    [state.selectedFile, dispatch, runRequest],
  );

  const selectedRequest = state.selectedFile?.requests.find(
    (r) => stableId(state.selectedFile!.path, r) === state.selectedRequestId,
  );

  // ── pane bodies ────────────────────────────────────────────────────
  const treePane = (
    <PaneFrame
      title="Files"
      state={paneState("tree")}
      hidden={isMaximized && maxKey !== "tree"}
      onToggleCollapse={() => toggleCollapse("tree")}
      onToggleMaximize={() => toggleMaximize("tree")}
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: ["http-files"] })
          }
          title="Refresh"
        >
          <RefreshCw className="size-3" />
        </Button>
      }
    >
      <div className="h-full overflow-y-auto">
        <HttpFileTree
          selectedPath={state.selectedFilePath}
          onSelect={(item) =>
            dispatch({
              type: "selectFile",
              path: item.path,
              file: null,
            })
          }
        />
      </div>
    </PaneFrame>
  );

  const listPaneTitle = isPerf
    ? (state.selectedFilePath?.split("/").pop() ?? "Perf tests")
    : (state.selectedFile?.filename ?? "Requests");

  const listPane = (
    <PaneFrame
      title={listPaneTitle}
      state={paneState("list")}
      hidden={isMaximized && maxKey !== "list"}
      onToggleCollapse={() => toggleCollapse("list")}
      onToggleMaximize={() => toggleMaximize("list")}
    >
      <div className="h-full overflow-y-auto">
        {isPerf ? (
          <PerfTestList
            tests={perf.tests}
            selectedIndex={perf.selectedTest}
            isRunning={perf.isRunning}
            onSelect={perf.setSelectedTest}
            onRun={(idx) => void perf.run(idx)}
          />
        ) : state.selectedFile ? (
          <RequestList
            filePath={state.selectedFile.path}
            requests={state.selectedFile.requests}
            selectedId={state.selectedRequestId}
            envVars={envVars}
            extractedVars={extractedVars}
            localVars={state.selectedFile.localVariables}
            onSelect={(id) => dispatch({ type: "selectRequest", id })}
            onRun={(req) => handleRunLine(req.lineNumber)}
            onRunWithDeps={(req) => handleRunLine(req.lineNumber, true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
            Pick a file from the tree.
          </div>
        )}
      </div>
    </PaneFrame>
  );

  const runningSingle = state.isRunning && state.runMode === "single";
  const runningDeps = state.isRunning && state.runMode === "withDeps";

  const editorTitle = isPerf
    ? `${state.selectedFilePath?.split("/").pop() ?? "Perf"}${isDirty ? " ●" : ""}`
    : state.selectedFile
      ? `${state.selectedFile.filename}${isDirty ? " ●" : ""}`
      : "Editor";

  const editorPane = (
    <PaneFrame
      title={editorTitle}
      state={paneState("editor")}
      hidden={isMaximized && maxKey !== "editor"}
      onToggleCollapse={() => toggleCollapse("editor")}
      onToggleMaximize={() => toggleMaximize("editor")}
      actions={
        state.selectedFilePath ? (
          isPerf ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={perf.selectedTest === null || perf.isRunning}
                onClick={() =>
                  perf.selectedTest !== null && void perf.run(perf.selectedTest)
                }
                title="Run perf test"
              >
                <Play className="size-3" /> Run
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!perf.isRunning}
                onClick={() => void perf.stop()}
                title="Stop perf test"
              >
                <Square className="size-3" /> Stop
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!perf.metrics}
                onClick={() => void perf.exportResults()}
                title="Export results to CSV"
              >
                <Download className="size-3" /> Export
              </Button>
              <PerfSchemaSheet>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 px-1.5 text-[10px]"
                  title="YAML schema reference"
                >
                  <BookOpen className="size-3" /> Schema
                </Button>
              </PerfSchemaSheet>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={() =>
                  editorRef.current && handleSave(editorRef.current.getValue())
                }
                title={isDirty ? "Save (Cmd+S) — unsaved changes" : "Save (Cmd+S)"}
              >
                <Save
                  className={isDirty ? "size-3 text-primary" : "size-3"}
                />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!selectedRequest || state.isRunning}
                onClick={() =>
                  selectedRequest && handleRunLine(selectedRequest.lineNumber)
                }
                title="Run (Cmd+Enter)"
              >
                {runningSingle ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Play className="size-3" />
                )}{" "}
                Run
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!selectedRequest || state.isRunning}
                onClick={() =>
                  selectedRequest &&
                  handleRunLine(selectedRequest.lineNumber, true)
                }
                title="Run with dependencies (Cmd+Shift+Enter)"
              >
                {runningDeps ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <GitBranch className="size-3" />
                )}{" "}
                Deps
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={() =>
                  editorRef.current && handleSave(editorRef.current.getValue())
                }
                title={isDirty ? "Save (Cmd+S) — unsaved changes" : "Save (Cmd+S)"}
              >
                <Save
                  className={isDirty ? "size-3 text-primary" : "size-3"}
                />
              </Button>
            </>
          )
        ) : null
      }
    >
      {state.selectedFilePath ? (
        <HttpEditor
          imperativeRef={editorRef}
          value={editorValue}
          mode={isPerf ? "plain" : "http"}
          onSave={handleSave}
          onChange={handleEditorChange}
          onRunLine={(line) => handleRunLine(line)}
          onRunLineWithDeps={(line) => handleRunLine(line, true)}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
          Pick a file to edit.
        </div>
      )}
    </PaneFrame>
  );

  const responsePane = (
    <PaneFrame
      title={isPerf ? "Metrics" : "Response"}
      orientation="vertical"
      state={paneState("response")}
      hidden={isMaximized && maxKey !== "response"}
      onToggleCollapse={() => toggleCollapse("response")}
      onToggleMaximize={() => toggleMaximize("response")}
    >
      {isPerf ? (
        <PerfDashboard
          metrics={perf.metrics}
          currentUsers={perf.currentUsers}
          exportToast={perf.exportToast}
        />
      ) : (
        <ResponsePanel envVars={envVars} extractedVars={extractedVars} />
      )}
    </PaneFrame>
  );

  // ── render ─────────────────────────────────────────────────────────
  // When a pane is maximized, render only that pane (full bleed).
  if (isMaximized && maxKey) {
    const maximized = {
      tree: treePane,
      list: listPane,
      editor: editorPane,
      response: responsePane,
    }[maxKey];
    return <div className="h-full w-full">{maximized}</div>;
  }

  // Layout:
  //   ┌─tree─┬──────list──┬──editor──┐
  //   │      │            │          │
  //   │      ├────────────┴──────────┤
  //   │      │     response          │
  //   └──────┴───────────────────────┘
  // - tree owns the full left column
  // - the right column is split vertically: top row = list + editor
  //   (horizontally split), bottom = response (full width of right col)
  const showTreeHandle = !collapsed.tree;
  const showListHandle = !collapsed.list;
  const editorCollapsed = collapsed.editor;
  const responseCollapsed = collapsed.response;
  const showEditorYHandle = !collapsed.list || !collapsed.editor;

  return (
    <div className="flex h-full w-full min-h-0">
      {/* Left: file tree, full height */}
      <div
        className="flex h-full min-h-0 flex-col border-r"
        style={horizontalSize("tree", treeWidth)}
      >
        {treePane}
      </div>
      {showTreeHandle && (
        <DragHandle
          direction="x"
          initial={treeWidth}
          min={160}
          max={420}
          onResize={setTreeWidth}
        />
      )}

      {/* Right column: top row [list | editor], bottom row [response] */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          {/* List: fixed width unless the editor is collapsed (then it
              absorbs the freed-up space so we never leave a white gap). */}
          <div
            className="flex h-full min-h-0 flex-col border-r"
            style={
              collapsed.list
                ? { width: 32, flex: "none" }
                : editorCollapsed
                  ? { flex: 1 }
                  : { width: listWidth, flex: "none" }
            }
          >
            {listPane}
          </div>
          {showListHandle && !editorCollapsed && (
            <DragHandle
              direction="x"
              initial={listWidth}
              min={200}
              max={500}
              onResize={setListWidth}
            />
          )}
          {/* Editor: stretches to fill, except when collapsed (32px). */}
          <div
            className={
              editorCollapsed
                ? "shrink-0 border-l"
                : "flex min-h-0 flex-1 flex-col border-l"
            }
            style={editorCollapsed ? { width: 32 } : undefined}
          >
            {editorPane}
          </div>
        </div>
        {!responseCollapsed && showEditorYHandle && (
          <DragHandle
            direction="y"
            inverse
            initial={responseHeight}
            min={120}
            max={600}
            onResize={setResponseHeight}
          />
        )}
        <div
          className="flex shrink-0 flex-col border-t"
          style={
            responseCollapsed
              ? { height: 32 }
              : { height: responseHeight }
          }
        >
          {responsePane}
        </div>
      </div>
    </div>
  );
}
