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
export { makeEditorTheme } from "./cm-theme";
