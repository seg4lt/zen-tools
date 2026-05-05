/**
 * `@zen-tools/editor` — themed CodeMirror 6 wrapper shared by every
 * editor host in the app (HTTP runner, Database Explorer, Markdown).
 *
 * The package is host-agnostic: callers pass `isDark` as a prop so
 * the package never has to import the host's `useTheme` hook (or
 * any other Tauri / router dependency).
 */

export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorProps,
} from "./code-editor";
export {
  DiffViewer,
  type DiffViewerProps,
  type InlineComment,
} from "./diff-viewer";
export { makeEditorTheme } from "./cm-theme";
export {
  type MoveDirection,
  type SplitDirection,
  type SplitNode,
  adjacentLeaf,
  closeLeaf,
  hasLeaf,
  leafCount,
  leafIds,
  makeRoot,
  resizeBranch,
  splitLeaf,
} from "./split-tree";
export { SplitLayout, type SplitLayoutProps } from "./split-layout";
export { type WorkspaceContext } from "./workspace-context";
export { useWorkspaceVim } from "./use-workspace-vim";
export { useJumpList, type JumpEntry, type JumpListApi } from "./use-jump-list";
export {
  useSplitWorkspace,
  type SplitWorkspaceApi,
} from "./use-split-workspace";
