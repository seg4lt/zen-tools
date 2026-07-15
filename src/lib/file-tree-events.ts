import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const FILE_TREE_CHANGED_EVENT = "file-tree:changed";

export type FileTreeScope = "http" | "sql" | "markdown";

export interface FileTreeChangedEvent {
  scope: FileTreeScope;
}

/** Subscribe to the Rust filesystem watcher's debounced change events. */
export function onFileTreeChanged(
  handler: (event: FileTreeChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileTreeChangedEvent>(FILE_TREE_CHANGED_EVENT, (event) =>
    handler(event.payload),
  );
}
