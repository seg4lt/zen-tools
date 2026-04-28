/**
 * Placeholder for the Requests sub-view. Phase 8 replaces this with the
 * real 3-pane layout (file tree | request list | editor + response).
 */
export function RequestsView() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-xl font-semibold">HTTP Runner — Requests</h2>
        <p className="text-sm text-muted-foreground">
          Pane layout, file tree, and request list land in the next commit.
        </p>
      </div>
    </div>
  );
}
