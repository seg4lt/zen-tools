import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, GitBranch } from "lucide-react";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { HttpFileTree } from "./components/http-file-tree";
import { RequestList } from "./components/request-list";
import {
  HttpEditor,
  type HttpEditorHandle,
} from "./components/http-editor";
import { ResponsePanel } from "./components/response-panel";
import { onRequestChain, onRequestResult, tauri } from "./lib/tauri";
import { stableId, useHttpRunner } from "./store/http-runner-store";

/**
 * Three-pane layout: file tree | request list | (editor + response panel
 * stacked vertically). Streams `request:result` and `request:chain` events
 * from the Tauri backend into the reducer.
 */
export function RequestsView() {
  const { state, dispatch } = useHttpRunner();
  const [treeWidth, setTreeWidth] = useState(220);
  const [listWidth, setListWidth] = useState(280);
  const [responseHeight, setResponseHeight] = useState(280);
  const queryClient = useQueryClient();
  const editorRef = useRef<HttpEditorHandle>(null);
  const [editorValue, setEditorValue] = useState("");

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

  return (
    <div className="flex h-full w-full min-h-0">
      {/* File tree pane */}
      <div
        className="flex h-full min-h-0 flex-col border-r"
        style={{ width: `${treeWidth}px` }}
      >
        <PaneHeader
          title="Files"
          right={
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["http-files"] })
              }
            >
              Refresh
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
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
      </div>

      <DragHandle
        direction="x"
        initial={treeWidth}
        min={160}
        max={420}
        onResize={setTreeWidth}
      />

      {/* Request list pane */}
      <div
        className="flex h-full min-h-0 flex-col border-r"
        style={{ width: `${listWidth}px` }}
      >
        <PaneHeader
          title={state.selectedFile ? state.selectedFile.filename : "Requests"}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.selectedFile ? (
            <RequestList
              filePath={state.selectedFile.path}
              requests={state.selectedFile.requests}
              selectedId={state.selectedRequestId}
              onSelect={(id) => dispatch({ type: "selectRequest", id })}
              onRun={(req) => handleRunLine(req.lineNumber)}
            />
          ) : (
            <EmptyHint>Pick a file from the tree.</EmptyHint>
          )}
        </div>
      </div>

      <DragHandle
        direction="x"
        initial={listWidth}
        min={200}
        max={500}
        onResize={setListWidth}
      />

      {/* Editor + response stack */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <PaneHeader
            title={state.selectedFile?.filename ?? "Editor"}
            right={
              state.selectedFilePath ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs"
                    disabled={!selectedRequest || state.isRunning}
                    onClick={() =>
                      selectedRequest &&
                      handleRunLine(selectedRequest.lineNumber)
                    }
                    title="Run (Cmd+Enter)"
                  >
                    <Play className="size-3" /> Run
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs"
                    disabled={!selectedRequest || state.isRunning}
                    onClick={() =>
                      selectedRequest &&
                      handleRunLine(selectedRequest.lineNumber, true)
                    }
                    title="Run with dependencies (Cmd+Shift+Enter)"
                  >
                    <GitBranch className="size-3" /> With deps
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      editorRef.current &&
                      handleSave(editorRef.current.getValue())
                    }
                  >
                    Save
                  </Button>
                </div>
              ) : undefined
            }
          />
          <div className="min-h-0 flex-1">
            {state.selectedFilePath ? (
              <HttpEditor
                imperativeRef={editorRef}
                value={editorValue}
                onSave={handleSave}
                onRunLine={(line) => handleRunLine(line)}
                onRunLineWithDeps={(line) => handleRunLine(line, true)}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <EmptyHint>Pick a file to edit.</EmptyHint>
              </div>
            )}
          </div>
        </div>
        <DragHandle
          direction="y"
          initial={responseHeight}
          min={120}
          max={600}
          onResize={setResponseHeight}
        />
        <div
          className="flex shrink-0 flex-col border-t"
          style={{ height: `${responseHeight}px` }}
        >
          <PaneHeader title="Response" />
          <div className="min-h-0 flex-1">
            <ResponsePanel />
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card/40 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span className="truncate">{title}</span>
      <div className="ml-auto">{right}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-center text-xs text-muted-foreground">{children}</p>
  );
}
