/**
 * Typed wrappers around every Tauri command exposed by `src-tauri`.
 *
 * These TypeScript types are hand-mirrored from the Rust DTOs. When the
 * Rust side changes, update both ends — `tsc --noEmit` will not catch a
 * shape drift since `invoke` is generic.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ────────────────────────────────────────────────────────────────────────────
// Domain types (mirror zen-types + DTO layer)
// ────────────────────────────────────────────────────────────────────────────

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

export type FileType =
  | "httpFile"
  | "envFile"
  | "perfFile"
  | "perfVariableFile"
  | "directory";

export interface FileTreeItem {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  fileType: FileType;
}

export type DependencyRef =
  | { kind: "local"; name: string }
  | { kind: "crossFile"; filePath: string; requestName: string };

export interface HttpRequest {
  id: string;
  name: string | null;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  dependsOn: DependencyRef[];
  extract: Record<string, string>;
  assertions: string[];
  lineNumber: number;
}

export interface HttpFile {
  path: string;
  filename: string;
  requests: HttpRequest[];
  localVariables: Record<string, string>;
}

export interface EnvironmentFileDto {
  path: string;
  names: string[];
}

export interface OpenedHttpFileDto {
  file: HttpFile;
  localEnv: EnvironmentFileDto | null;
}

export interface HttpResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  duration: number; // milliseconds
  sizeBytes: number;
}

export type ExecutionStatus =
  | { type: "idle" }
  | { type: "running"; message: string | null }
  | { type: "success"; response: HttpResponse }
  | { type: "error"; message: string };

export interface RequestResult {
  requestId: string;
  status: ExecutionStatus;
  extractedVars: Record<string, string>;
  logMessage: string | null;
  newCookies: [string, string][];
  completedAt: string | null;
}

export interface AppErrorBody {
  kind: string;
  message: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Commands (one wrapper per #[tauri::command])
// ────────────────────────────────────────────────────────────────────────────

export const tauri = {
  // files
  discoverHttpFiles: () => invoke<FileTreeItem[]>("discover_http_files"),
  discoverPerfFiles: () => invoke<FileTreeItem[]>("discover_perf_files"),
  findEnvFile: (directory: string) =>
    invoke<string | null>("find_env_file_command", { directory }),
  setWorkingDir: (path: string) => invoke<void>("set_working_dir", { path }),
  getWorkingDir: () => invoke<string>("get_working_dir"),
  pickDirectory: () => invoke<string | null>("pick_directory"),

  // parse
  openHttpFile: (path: string) =>
    invoke<OpenedHttpFileDto>("open_http_file", { path }),
  readFileContent: (path: string) =>
    invoke<string>("read_file_content", { path }),
  writeFileContent: (path: string, content: string) =>
    invoke<void>("write_file_content", { path, content }),
  reloadHttpFile: (path: string) =>
    invoke<OpenedHttpFileDto>("reload_http_file", { path }),

  // environment
  listEnvironments: () => invoke<string[]>("list_environments"),
  setActiveEnvironment: (envName: string) =>
    invoke<void>("set_active_environment", { envName }),
  getActiveEnvironment: () =>
    invoke<string | null>("get_active_environment"),
  getEnvVars: () => invoke<Record<string, string>>("get_env_vars"),
  getExtractedVars: () =>
    invoke<Record<string, string>>("get_extracted_vars"),
  setExtractedVar: (key: string, value: string) =>
    invoke<void>("set_extracted_var", { key, value }),
  deleteExtractedVar: (key: string) =>
    invoke<void>("delete_extracted_var", { key }),
  clearExtractedVars: () => invoke<void>("clear_extracted_vars"),
  getCookies: () => invoke<[string, string][]>("get_cookies"),
  clearCookies: () => invoke<void>("clear_cookies"),
  loadEnvFile: (path: string) =>
    invoke<string[]>("load_env_file", { path }),

  // execute
  runRequest: (filePath: string, requestId: string) =>
    invoke<void>("run_request", { filePath, requestId }),
  runRequestWithDeps: (filePath: string, requestId: string) =>
    invoke<void>("run_request_with_deps", { filePath, requestId }),
  buildCurlCommand: (filePath: string, requestId: string) =>
    invoke<string>("build_curl_command", { filePath, requestId }),

  // misc
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),
};

// ────────────────────────────────────────────────────────────────────────────
// Event helpers
// ────────────────────────────────────────────────────────────────────────────

/** Listen for `request:result` events. Returns an unlisten function. */
export function onRequestResult(
  handler: (payload: RequestResult) => void,
): Promise<UnlistenFn> {
  return listen<RequestResult>("request:result", (e) => handler(e.payload));
}

/** Listen for `request:chain` events (planned execution chain preview). */
export function onRequestChain(
  handler: (payload: { steps: { id: string; name: string }[] }) => void,
): Promise<UnlistenFn> {
  return listen<{ steps: { id: string; name: string }[] }>(
    "request:chain",
    (e) => handler(e.payload),
  );
}
