/**
 * Typed wrappers around every Tauri command exposed by `src-tauri`.
 *
 * These TypeScript types are hand-mirrored from the Rust DTOs. When the
 * Rust side changes, update both ends — `tsc --noEmit` will not catch a
 * shape drift since `invoke` is generic.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  MetricsSnapshot,
  PerfConfigDto,
  PerfUpdate,
} from "./perf-types";

export type { MetricsSnapshot, PerfConfigDto, PerfUpdate };

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

/**
 * One project's slice of the discovered tree. The frontend renders one
 * top-level node per `DiscoveredProject` returned by `discoverHttpFiles`.
 */
export interface DiscoveredProject {
  /** Absolute path of the project root. */
  root: string;
  /** Basename of the root, used as the section header. */
  name: string;
  /** Pre-order DFS list of files + directories under this root. */
  items: FileTreeItem[];
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
  /**
   * Set when the backend auto-selected an environment as a side
   * effect of opening this file (because nothing was previously
   * active). The frontend should mirror it into the runner store +
   * invalidate env-aware queries.
   */
  autoSelectedEnv: string | null;
}

/** Ordered list of `[name, value]` pairs — duplicate-named headers (Set-Cookie, Vary, etc.) survive. */
export type HeaderPairs = Array<[string, string]>;

export interface HttpResponse {
  statusCode: number;
  statusText: string;
  /**
   * Ordered list of header pairs. Use a `Vec` (not a map) on the wire
   * so duplicates such as `Set-Cookie` aren't collapsed.
   */
  headers: HeaderPairs;
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
  discoverHttpFiles: () => invoke<DiscoveredProject[]>("discover_http_files"),
  findEnvFile: (directory: string) =>
    invoke<string | null>("find_env_file_command", { directory }),
  /** Add a project root. Returns the canonical list after the update. */
  addWorkingDir: (path: string) =>
    invoke<string[]>("add_working_dir", { path }),
  /** Remove a project root. Returns the canonical list after the update. */
  removeWorkingDir: (path: string) =>
    invoke<string[]>("remove_working_dir", { path }),
  listWorkingDirs: () => invoke<string[]>("list_working_dirs"),
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

  // perf
  loadPerfConfig: (path: string) =>
    invoke<PerfConfigDto>("load_perf_config", { path }),
  runPerfTest: (testIndex: number) =>
    invoke<void>("run_perf_test", { testIndex }),
  stopPerfTest: () => invoke<void>("stop_perf_test"),
  exportPerfResults: (outputDir?: string) =>
    invoke<string>("export_perf_results", { outputDir: outputDir ?? null }),
  getPerfMetrics: () => invoke<MetricsSnapshot | null>("get_perf_metrics"),

  // misc
  openInEditor: (path: string) => invoke<void>("open_in_editor", { path }),

  // preferences (persisted to disk in the OS-specific app-data dir)
  getPreferences: () => invoke<Preferences>("get_preferences"),
  savePreferences: (prefs: Preferences) =>
    invoke<void>("save_preferences", { prefs }),

  // run history (last 10 runs per request, persisted to runs.json)
  recordRun: (requestId: string, entry: RunHistoryEntry) =>
    invoke<void>("record_run", { requestId, entry }),
  getRunHistory: (requestId: string) =>
    invoke<RunHistoryEntry[]>("get_run_history", { requestId }),
  clearRunHistory: (requestId?: string) =>
    invoke<void>("clear_run_history", { requestId: requestId ?? null }),
};

/** One captured run for a request. Mirrors the Rust `RunHistoryEntry`. */
export interface RunHistoryEntry {
  /** ISO-8601 wall-clock completion time. */
  timestamp: string;
  outcome: "success" | "error";
  method: string;
  url: string;
  statusCode: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  body: string;
  bodyTruncated: boolean;
  headers: HeaderPairs;
  extractedVars: Record<string, string>;
  errorMessage: string | null;
}

/**
 * Persisted UI state — mirrors a *subset* of the Rust `Preferences`
 * struct. The Rust side has more fields (cleaner, markdown, database
 * explorer, …) but the http-runner only consumes / writes these.
 * Other tools that round-trip prefs do `{ ...prefs, myField: ... }`
 * so unknown fields survive untouched.
 */
export interface Preferences {
  workingDirs: string[];
  expandedPaths: string[];
  /** `true` when the editor's Vim keybindings should be active. */
  vimMode: boolean;
  /** Whole-app CSS zoom level on `<html>`. Default 1.0. */
  appZoom?: number;
  /** User-defined tool ordering for the title-bar pills. */
  toolOrder?: string[];
}

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

/** Listen for `perf:update` events. */
export function onPerfUpdate(
  handler: (payload: PerfUpdate) => void,
): Promise<UnlistenFn> {
  return listen<PerfUpdate>("perf:update", (e) => handler(e.payload));
}
