import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, GitBranch, RefreshCw, Save } from "lucide-react";
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
import { onRequestChain, onRequestResult, tauri } from "./lib/tauri";
import { stableId, useHttpRunner } from "./store/http-runner-store";

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
  const [paneStates, setPaneStates] = useState<Record<PaneKey, PaneState>>({
    tree: "normal",
    list: "normal",
    editor: "normal",
    response: "normal",
  });
  const queryClient = useQueryClient();
  const editorRef = useRef<HttpEditorHandle>(null);
  const [editorValue, setEditorValue] = useState("");

  // ── pane layout helpers ────────────────────────────────────────────
  const toggleCollapse = (key: PaneKey) =>
    setPaneStates((prev) => ({
      ...prev,
      [key]: prev[key] === "collapsed" ? "normal" : "collapsed",
      // Collapsing a pane while another is maximized would be confusing,
      // so collapsing always returns the layout to normal-mode-ish.
    }));

  const toggleMaximize = (key: PaneKey) =>
    setPaneStates((prev) => {
      const isMax = prev[key] === "maximized";
      return {
        tree: isMax ? "normal" : "tree" === key ? "maximized" : "normal",
        list: isMax ? "normal" : "list" === key ? "maximized" : "normal",
        editor: isMax ? "normal" : "editor" === key ? "maximized" : "normal",
        response: isMax
          ? "normal"
          : "response" === key
            ? "maximized"
            : "normal",
      };
    });

  const maxKey = (Object.keys(paneStates) as PaneKey[]).find(
    (k) => paneStates[k] === "maximized",
  );
  const isMaximized = maxKey != null;

  // Width/height for a horizontally-arranged pane.
  const horizontalSize = (
    key: PaneKey,
    nominal: number,
  ): React.CSSProperties => {
    if (paneStates[key] === "collapsed") return { width: 32, flex: "none" };
    if (paneStates[key] === "maximized") return { flex: 1 };
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
        }
        if (payload.logMessage) {
          dispatch({ type: "log", message: payload.logMessage });
        }
      }),
      onRequestChain((payload) => {
        dispatch({ type: "chain", steps: payload.steps });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [dispatch]);

  const { data: opened } = useQuery({
    queryKey: ["http-file", state.selectedFilePath],
    queryFn: () => tauri.openHttpFile(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  const { data: rawContent } = useQuery({
    queryKey: ["http-file-content", state.selectedFilePath],
    queryFn: () => tauri.readFileContent(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  useEffect(() => {
    if (opened && opened.file.path !== state.selectedFile?.path) {
      dispatch({
        type: "selectFile",
        path: opened.file.path,
        file: opened.file,
      });
    }
  }, [opened, state.selectedFile?.path, dispatch]);

  useEffect(() => {
    if (rawContent !== undefined && rawContent !== null) {
      setEditorValue(rawContent);
      editorRef.current?.setValue(rawContent);
    }
  }, [rawContent]);

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
        const fresh = await tauri.reloadHttpFile(state.selectedFilePath);
        dispatch({
          type: "selectFile",
          path: fresh.file.path,
          file: fresh.file,
        });
        dispatch({ type: "log", message: `Saved ${fresh.file.filename}` });
      } catch (err) {
        dispatch({
          type: "log",
          level: "error",
          message: `Save failed: ${(err as { message?: string }).message ?? err}`,
        });
      }
    },
    [dispatch, state.selectedFilePath],
  );

  const runRequest = useCallback(
    async (
      filePath: string,
      requestId: string,
      withDeps: boolean,
    ): Promise<void> => {
      try {
        if (withDeps) {
          await tauri.runRequestWithDeps(filePath, requestId);
        } else {
          await tauri.runRequest(filePath, requestId);
        }
      } catch (err) {
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
      state={paneStates.tree}
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

  const listPane = (
    <PaneFrame
      title={state.selectedFile?.filename ?? "Requests"}
      state={paneStates.list}
      hidden={isMaximized && maxKey !== "list"}
      onToggleCollapse={() => toggleCollapse("list")}
      onToggleMaximize={() => toggleMaximize("list")}
    >
      <div className="h-full overflow-y-auto">
        {state.selectedFile ? (
          <RequestList
            filePath={state.selectedFile.path}
            requests={state.selectedFile.requests}
            selectedId={state.selectedRequestId}
            onSelect={(id) => dispatch({ type: "selectRequest", id })}
            onRun={(req) => handleRunLine(req.lineNumber)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
            Pick a file from the tree.
          </div>
        )}
      </div>
    </PaneFrame>
  );

  const editorPane = (
    <PaneFrame
      title={state.selectedFile?.filename ?? "Editor"}
      state={paneStates.editor}
      hidden={isMaximized && maxKey !== "editor"}
      onToggleCollapse={() => toggleCollapse("editor")}
      onToggleMaximize={() => toggleMaximize("editor")}
      actions={
        state.selectedFilePath ? (
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
              <Play className="size-3" /> Run
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
              <GitBranch className="size-3" /> Deps
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={() =>
                editorRef.current && handleSave(editorRef.current.getValue())
              }
              title="Save (Cmd+S)"
            >
              <Save className="size-3" />
            </Button>
          </>
        ) : null
      }
    >
      {state.selectedFilePath ? (
        <HttpEditor
          imperativeRef={editorRef}
          value={editorValue}
          onSave={handleSave}
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
      title="Response"
      orientation="vertical"
      state={paneStates.response}
      hidden={isMaximized && maxKey !== "response"}
      onToggleCollapse={() => toggleCollapse("response")}
      onToggleMaximize={() => toggleMaximize("response")}
    >
      <ResponsePanel />
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

  // Normal three-column + vertical-split layout.
  const showTreeHandle = paneStates.tree !== "collapsed";
  const showListHandle = paneStates.list !== "collapsed";
  const editorCollapsed = paneStates.editor === "collapsed";
  const responseCollapsed = paneStates.response === "collapsed";

  return (
    <div className="flex h-full w-full min-h-0">
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

      <div
        className="flex h-full min-h-0 flex-col border-r"
        style={horizontalSize("list", listWidth)}
      >
        {listPane}
      </div>
      {showListHandle && (
        <DragHandle
          direction="x"
          initial={listWidth}
          min={200}
          max={500}
          onResize={setListWidth}
        />
      )}

      {/* Right column: editor on top, response on bottom (vertical split). */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div
          className={editorCollapsed ? "shrink-0" : "flex min-h-0 flex-1 flex-col"}
        >
          {editorPane}
        </div>
        {!editorCollapsed && !responseCollapsed && (
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
              : editorCollapsed
                ? { flex: 1 }
                : { height: responseHeight }
          }
        >
          {responsePane}
        </div>
      </div>
    </div>
  );
}
