import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DragHandle } from "@/components/drag-handle";
import { Button } from "@/components/ui/button";
import { HttpFileTree } from "./components/http-file-tree";
import { RequestList } from "./components/request-list";
import { tauri } from "./lib/tauri";
import { stableId, useHttpRunner } from "./store/http-runner-store";

/**
 * Three-pane layout: file tree | request list | editor + response panel
 * (the right two will be filled in later phases).
 */
export function RequestsView() {
  const { state, dispatch } = useHttpRunner();
  const [treeWidth, setTreeWidth] = useState(220);
  const [listWidth, setListWidth] = useState(280);
  const queryClient = useQueryClient();

  const { data: opened } = useQuery({
    queryKey: ["http-file", state.selectedFilePath],
    queryFn: () => tauri.openHttpFile(state.selectedFilePath!),
    enabled: state.selectedFilePath !== null,
  });

  // Sync the parsed file into the store once the query resolves.
  useEffect(() => {
    if (opened && opened.file.path !== state.selectedFile?.path) {
      dispatch({
        type: "selectFile",
        path: opened.file.path,
        file: opened.file,
      });
    }
  }, [opened, state.selectedFile?.path, dispatch]);

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
          title={
            state.selectedFile
              ? state.selectedFile.filename
              : "Requests"
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.selectedFile ? (
            <RequestList
              filePath={state.selectedFile.path}
              requests={state.selectedFile.requests}
              selectedId={state.selectedRequestId}
              onSelect={(id) =>
                dispatch({ type: "selectRequest", id })
              }
              onRun={(req) => {
                // Phase 11 wires this to the actual run command.
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

      {/* Right pane: editor + response — filled in phases 9–11. */}
      <div className="flex h-full min-h-0 flex-1 flex-col bg-card/40">
        <PaneHeader title="Editor" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyHint>
            Editor (CodeMirror + Vim) lands in the next commit.
          </EmptyHint>
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
