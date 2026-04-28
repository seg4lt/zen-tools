import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { HttpFileTree } from "./components/http-file-tree";
import { RequestList } from "./components/request-list";
import {
  HttpEditor,
  type HttpEditorHandle,
} from "./components/http-editor";
import { tauri } from "./lib/tauri";
import { stableId, useHttpRunner } from "./store/http-runner-store";

/**
 * Three-pane layout: file tree | request list | editor.
 * Response panel and run plumbing are added in subsequent commits.
 */
export function RequestsView() {
  const { state, dispatch } = useHttpRunner();
  const [treeWidth, setTreeWidth] = useState(220);
  const [listWidth, setListWidth] = useState(280);
  const queryClient = useQueryClient();
  const editorRef = useRef<HttpEditorHandle>(null);
  const [editorValue, setEditorValue] = useState("");

  // Parse on file selection.
  const { data: opened } = useQuery({
    queryKey: ["http-file", state.selectedFilePath],
    queryFn: () => tauri.openHttpFile(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  // Read the raw text on file selection so the editor shows the full source.
  const { data: rawContent } = useQuery({
    queryKey: ["http-file-content", state.selectedFilePath],
    queryFn: () => tauri.readFileContent(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  // Sync the parsed file into the store.
  useEffect(() => {
    if (opened && opened.file.path !== state.selectedFile?.path) {
      dispatch({
        type: "selectFile",
        path: opened.file.path,
        file: opened.file,
      });
    }
  }, [opened, state.selectedFile?.path, dispatch]);

  // Push fresh file content into the editor.
  useEffect(() => {
    if (rawContent !== undefined && rawContent !== null) {
      setEditorValue(rawContent);
      editorRef.current?.setValue(rawContent);
    }
  }, [rawContent]);

  // Jump editor cursor to the line of the selected request.
  useEffect(() => {
    if (!state.selectedRequestId || !state.selectedFile) return;
    const req = state.selectedFile.requests.find(
      (r) => stableId(state.selectedFile!.path, r) === state.selectedRequestId,
    );
    if (req) {
      editorRef.current?.scrollToLine(req.lineNumber);
    }
  }, [state.selectedRequestId, state.selectedFile]);

  const handleSave = async (value: string) => {
    if (!state.selectedFilePath) return;
    try {
      await tauri.writeFileContent(state.selectedFilePath, value);
      // Re-parse so request list stays in sync.
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
  };

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
              onRun={(req) => {
                dispatch({
                  type: "log",
                  message: `Run requested: ${req.name ?? req.url}`,
                });
                dispatch({
                  type: "selectRequest",
                  id: stableId(state.selectedFile!.path, req),
                });
              }}
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

      {/* Editor pane */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <PaneHeader
          title={state.selectedFile?.filename ?? "Editor"}
          right={
            state.selectedFilePath ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => editorRef.current && handleSave(editorRef.current.getValue())}
              >
                Save
              </Button>
            ) : undefined
          }
        />
        <div className="min-h-0 flex-1">
          {state.selectedFilePath ? (
            <HttpEditor
              imperativeRef={editorRef}
              value={editorValue}
              onSave={handleSave}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <EmptyHint>Pick a file to edit.</EmptyHint>
            </div>
          )}
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
