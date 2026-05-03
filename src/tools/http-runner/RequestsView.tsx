import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SplitLayout,
  useJumpList,
  useSplitWorkspace,
  useWorkspaceVim,
  type JumpEntry,
  type WorkspaceContext,
} from "@zen-tools/editor";
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
import { Button } from "@zen-tools/ui";
import { HttpFileTree } from "./components/http-file-tree";
import { RequestList } from "./components/request-list";
import {
  HttpEditor,
  type HttpEditorHandle,
} from "./components/http-editor";
import { ResponsePanel } from "./components/response-panel";
import { PaneFrame, type PaneState } from "./components/pane-frame";
import { PerfTestList } from "./components/perf-test-list";
// PerfDashboard pulls in `recharts` (~300 KB) for the latency
// histogram + sparklines. Lazy-load it so the HTTP-runner's request
// view stays slim — users who never run a perf test pay zero
// recharts cost. Mirrors the lazy import pattern Markdown uses for
// Excalidraw.
const PerfDashboard = lazy(() =>
  import("./components/perf-dashboard").then((m) => ({
    default: m.PerfDashboard,
  })),
);
import { PerfSchemaSheet } from "./components/perf-schema-sheet";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useVimMode } from "@/hooks/use-vim-mode";
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
  const { vimMode: vimModeEnabled } = useVimMode();
  // The streaming-event listener (registered once on mount) reads
  // `selectedFile` lazily through a ref so it sees the current value
  // at fire time — without this, captured `state` would be the null
  // at first render and the recorded URL would always be empty.
  const selectedFileRef = useRef(state.selectedFile);
  useEffect(() => {
    selectedFileRef.current = state.selectedFile;
  }, [state.selectedFile]);
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
  // One editor handle per split leaf. Run / save flows read from
  // the focused leaf so the user's selection / cursor in *that*
  // split drives the action.
  const leafHandlesRef = useRef<Map<string, HttpEditorHandle>>(new Map());
  const workspace = useSplitWorkspace();
  const jumpList = useJumpList();
  const focusedHandle = useCallback(
    () => leafHandlesRef.current.get(workspace.focusedLeafId) ?? null,
    [workspace.focusedLeafId],
  );
  const broadcastSetValue = useCallback((content: string) => {
    for (const h of leafHandlesRef.current.values()) h.setValue(content);
  }, []);
  const broadcastScrollToLine = useCallback((line: number) => {
    // Only the focused leaf jumps to the line — siblings stay where
    // the user left them. Mirrors vim semantics for picking a
    // request from the list.
    focusedHandle()?.scrollToLine(line);
  }, [focusedHandle]);
  /** Disk-baseline — last known on-disk content for the active file. */
  const [editorValue, setEditorValue] = useState("");
  /** Live editor buffer. Updated on every keystroke; drives the
   *  shared {@link useAutoSave} hook below. */
  const [liveValue, setLiveValue] = useState("");
  const isDirty = liveValue !== editorValue;
  /**
   * `true` while we are programmatically pushing content into the editor
   * (e.g. after `rawContent` loads or a save round-trips). CodeMirror's
   * `updateListener` fires synchronously inside `setValue`, so without
   * this flag every file load would schedule a debounced auto-save of
   * the freshly-loaded file ~1s later — which felt like a "refresh".
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

        // Persist the run to history (last-10 ring buffer per request,
        // backend-owned). Skip the ephemeral idle/running events —
        // only completed outcomes are worth keeping for diffing.
        if (
          payload.status.type === "success" ||
          payload.status.type === "error"
        ) {
          const file = selectedFileRef.current;
          const requestForUrl = file?.requests.find(
            (r) => stableId(file.path, r) === payload.requestId,
          );
          const method = requestForUrl?.method ?? "GET";
          const url = requestForUrl?.url ?? "";
          const entry =
            payload.status.type === "success"
              ? {
                  timestamp:
                    payload.completedAt ?? new Date().toISOString(),
                  outcome: "success" as const,
                  method,
                  url,
                  statusCode: payload.status.response.statusCode,
                  statusText: payload.status.response.statusText,
                  durationMs: payload.status.response.duration,
                  sizeBytes: payload.status.response.sizeBytes,
                  body: payload.status.response.body,
                  bodyTruncated: false,
                  headers: payload.status.response.headers,
                  extractedVars: payload.extractedVars ?? {},
                  errorMessage: null,
                }
              : {
                  timestamp:
                    payload.completedAt ?? new Date().toISOString(),
                  outcome: "error" as const,
                  method,
                  url,
                  statusCode: null,
                  statusText: null,
                  durationMs: null,
                  sizeBytes: null,
                  body: "",
                  bodyTruncated: false,
                  headers: [],
                  extractedVars: payload.extractedVars ?? {},
                  errorMessage: payload.status.message,
                };
          void tauri
            .recordRun(payload.requestId, entry)
            .then(() => {
              void queryClient.invalidateQueries({
                queryKey: ["run-history", payload.requestId],
              });
            })
            .catch((err) =>
              console.warn("zen-tools: record_run failed", err),
            );
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
      void queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
      // The backend may have just auto-selected an environment because
      // none was active. Mirror that selection into the front-end
      // store so `{{host}}` etc. resolve immediately on the Sent tab
      // and request-list URL preview — the env-vars query is keyed on
      // `state.activeEnv`, and without this it stays disabled.
      if (opened.autoSelectedEnv) {
        dispatch({ type: "setEnv", env: opened.autoSelectedEnv });
      }
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
        setLiveValue(rawContent);
        broadcastSetValue(rawContent);
      } finally {
        applyingExternalRef.current = false;
      }
    }
  }, [rawContent]);

  useEffect(() => {
    if (!state.selectedRequestId || !state.selectedFile) return;
    const req = state.selectedFile.requests.find(
      (r) => stableId(state.selectedFile!.path, r) === state.selectedRequestId,
    );
    if (req) {
      broadcastScrollToLine(req.lineNumber);
    }
  }, [state.selectedRequestId, state.selectedFile, broadcastScrollToLine]);

  /**
   * Disk-write + reparse. Used both by the shared autosave debounce
   * and by the explicit ⌘S handler.
   */
  const doSave = useCallback(
    async (path: string, value: string) => {
      await tauri.writeFileContent(path, value);
      // Only `.http`/`.rest` files go through the http parser. For
      // perf YAMLs we just invalidate the perf-config query so the
      // test list re-parses on the next render.
      if (isPerf) {
        await queryClient.invalidateQueries({
          queryKey: ["perf-config", path],
        });
      } else {
        const fresh = await tauri.reloadHttpFile(path);
        // Use updateParsedFile (not selectFile) so the editor cursor +
        // selected request are preserved across the save.
        dispatch({ type: "updateParsedFile", file: fresh.file });
      }
      // Bump the disk baseline (the dirty flag derives from
      // `liveValue !== editorValue`) without pushing back into
      // CodeMirror — that would clobber the user's cursor.
      setEditorValue(value);
      // Keep the React Query cache in sync so other consumers
      // (re-mounts, refresh) get the new content on next access.
      queryClient.setQueryData(["http-file-content", path], value);
    },
    [dispatch, isPerf, queryClient],
  );

  // Shared trailing-edge debounce — same hook the SQL + markdown
  // editors use. 1 s is the consensus across all three.
  const autoSave = useAutoSave({
    key: state.selectedFilePath ?? null,
    content: liveValue,
    dirty: isDirty,
    save: doSave,
  });

  const handleSave = useCallback(
    async (value: string) => {
      if (!state.selectedFilePath) return;
      // ⌘S beats the autosave timer to it — cancel the pending write
      // so we don't double-save with potentially-stale content from
      // the debounce closure.
      autoSave.cancel();
      try {
        await doSave(state.selectedFilePath, value);
      } catch (err) {
        dispatch({
          type: "log",
          level: "error",
          message: `Save failed: ${(err as { message?: string }).message ?? err}`,
        });
      }
    },
    [autoSave, doSave, dispatch, state.selectedFilePath],
  );

  /**
   * Called on every keystroke from the editor. Tracks the live buffer
   * for the dirty indicator and the shared autosave hook. The
   * `applyingExternalRef` flag suppresses tracking when we're
   * programmatically pushing content (file load, save round-trip).
   */
  const handleEditorChange = useCallback(
    (next: string) => {
      if (applyingExternalRef.current) return;
      setLiveValue(next);
    },
    [],
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

  // ── Workspace bridge for `:q` / `:vsplit` / `:hsplit` ──────────────
  //
  // HTTP Runner has no tab strip — `:q` is a no-op when only one
  // leaf exists (per the user's spec). With multiple splits, `:q`
  // closes the focused split. `useSplitWorkspace.closeFocused()`
  // already enforces the "leave at least one leaf" invariant, so
  // we don't need a fallback path here.
  const workspaceContext = useMemo<WorkspaceContext>(
    () => ({
      closeActive: () => {
        workspace.closeFocused();
      },
      split: (direction) => workspace.split(direction),
      moveFocus: (dir) => workspace.moveFocus(dir),
    }),
    [workspace],
  );
  useWorkspaceVim(workspaceContext);

  // Push a jump entry whenever the user picks a different request
  // or moves focus to a different split. Within-buffer cursor jumps
  // (search, gg, G, %) stay handled by vim's per-view stack.
  useEffect(() => {
    if (!state.selectedRequestId) return;
    const handle = focusedHandle();
    jumpList.push({
      leafId: workspace.focusedLeafId,
      tabId: state.selectedRequestId,
      cursorOffset: handle?.getCursorOffset() ?? 0,
    });
  }, [
    state.selectedRequestId,
    workspace.focusedLeafId,
    jumpList,
    focusedHandle,
  ]);

  const navigateToJump = useCallback(
    (entry: JumpEntry | null): boolean => {
      if (!entry) return false;
      if (entry.tabId && entry.tabId !== state.selectedRequestId) {
        dispatch({ type: "selectRequest", id: entry.tabId });
      }
      if (entry.leafId !== workspace.focusedLeafId) {
        workspace.setFocus(entry.leafId);
      }
      requestAnimationFrame(() => {
        leafHandlesRef.current.get(entry.leafId)?.focus();
      });
      return true;
    },
    [state.selectedRequestId, dispatch, workspace],
  );
  const onJumpBack = useCallback(
    () => navigateToJump(jumpList.back()),
    [jumpList, navigateToJump],
  );
  const onJumpForward = useCallback(
    () => navigateToJump(jumpList.forward()),
    [jumpList, navigateToJump],
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
                  (() => {
                    const h = focusedHandle();
                    if (h) handleSave(h.getValue());
                  })()
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
                  (() => {
                    const h = focusedHandle();
                    if (h) handleSave(h.getValue());
                  })()
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
        // Splits live *inside* the editor pane only — the four
        // outer panes (tree | list | editor | response) are
        // unchanged. Each leaf has its own HttpEditor showing the
        // active request file.
        <SplitLayout
          root={workspace.tree}
          focusedLeafId={workspace.focusedLeafId}
          onFocusLeaf={workspace.setFocus}
          onResize={workspace.resize}
          renderLeaf={(leafId, focused) => (
            <HttpLeafShell
              leafId={leafId}
              focused={focused}
              value={editorValue}
              mode={isPerf ? "plain" : "http"}
              vimMode={vimModeEnabled}
              varContext={{
                extracted: extractedVars,
                local: state.selectedFile?.localVariables,
                env: envVars,
              }}
              onSave={handleSave}
              onChange={handleEditorChange}
              onRunLine={(line) => handleRunLine(line)}
              onRunLineWithDeps={(line) => handleRunLine(line, true)}
              onMoveFocus={workspace.moveFocus}
              onJumpBack={onJumpBack}
              onJumpForward={onJumpForward}
              registerHandle={(h) => {
                if (h) leafHandlesRef.current.set(leafId, h);
                else leafHandlesRef.current.delete(leafId);
              }}
            />
          )}
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
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Loading charts…
            </div>
          }
        >
          <PerfDashboard
            metrics={perf.metrics}
            currentUsers={perf.currentUsers}
            exportToast={perf.exportToast}
          />
        </Suspense>
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

/**
 * One leaf of the HTTP editor split workspace. Owns its own
 * `<HttpEditor>` (independent cursor / scroll / undo) and
 * registers its imperative handle with the parent so save / scroll
 * flows can target the focused leaf.
 */
interface HttpLeafShellProps {
  leafId: string;
  focused: boolean;
  value: string;
  mode: "http" | "plain";
  vimMode: boolean;
  varContext: React.ComponentProps<typeof HttpEditor>["varContext"];
  onSave: (next: string) => void;
  onChange: (next: string) => void;
  onRunLine: (line: number) => void;
  onRunLineWithDeps: (line: number) => void;
  onMoveFocus: (dir: "h" | "j" | "k" | "l") => void;
  onJumpBack: () => boolean;
  onJumpForward: () => boolean;
  registerHandle: (h: HttpEditorHandle | null) => void;
}

function HttpLeafShell({
  focused,
  value,
  mode,
  vimMode,
  varContext,
  onSave,
  onChange,
  onRunLine,
  onRunLineWithDeps,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  registerHandle,
}: HttpLeafShellProps) {
  const handleRef = useRef<HttpEditorHandle | null>(null);

  useEffect(() => {
    registerHandle(handleRef.current);
    return () => registerHandle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focused) handleRef.current?.focus();
  }, [focused]);

  return (
    <div
      className={
        focused
          ? "h-full w-full min-h-0 min-w-0 outline outline-1 outline-primary/40 -outline-offset-1"
          : "h-full w-full min-h-0 min-w-0"
      }
    >
      <HttpEditor
        imperativeRef={handleRef}
        value={value}
        mode={mode}
        vimMode={vimMode}
        varContext={varContext}
        onSave={onSave}
        onChange={onChange}
        onRunLine={onRunLine}
        onRunLineWithDeps={onRunLineWithDeps}
        onMoveFocus={onMoveFocus}
        onJumpBack={onJumpBack}
        onJumpForward={onJumpForward}
      />
    </div>
  );
}
