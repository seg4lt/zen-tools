/**
 * Dictation IPC: model dropdown, downloads, paths-on-disk.
 *
 * Wraps the seven `dictation_*` Tauri commands and the matching event
 * stream (`dictation:download-progress`). The DTO shapes live in the
 * generated TypeScript bindings at `@zen-tools/types/generated`; the
 * Rust source for the same types is `src-tauri/src/dictation/dto.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ModelDto,
  DictationStateDto,
  DownloadProgressDto,
  PathsDto,
} from "@zen-tools/types/generated";

/** React-Query key for the dictation snapshot. */
export const DICTATION_STATE_KEY = ["dictation", "state"] as const;
/** React-Query key for the on-disk paths panel. */
export const DICTATION_PATHS_KEY = ["dictation", "paths"] as const;

export const dictationIpc = {
  isSupported: (): Promise<boolean> => invoke<boolean>("dictation_is_supported"),
  listModels: (): Promise<ModelDto[]> => invoke<ModelDto[]>("dictation_list_models"),
  getState: (): Promise<DictationStateDto> => invoke<DictationStateDto>("dictation_get_state"),
  selectModel: (id: string): Promise<void> =>
    invoke<void>("dictation_select_model", { id }),
  downloadModel: (id: string): Promise<void> =>
    invoke<void>("dictation_download_model", { id }),
  openAppDataDir: (): Promise<void> => invoke<void>("dictation_open_app_data_dir"),
  openLogsDir: (): Promise<void> => invoke<void>("dictation_open_logs_dir"),
  openModelsDir: (): Promise<void> => invoke<void>("dictation_open_models_dir"),
  getPaths: (): Promise<PathsDto> => invoke<PathsDto>("dictation_get_paths"),
};

/**
 * Subscribe to download progress events. Returns the
 * Tauri-supplied unlisten function — call it on unmount.
 */
export function listenDownloadProgress(
  cb: (p: DownloadProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgressDto>("dictation:download-progress", (e) =>
    cb(e.payload),
  );
}

/** Three-state pipeline phase emitted by the Tauri dictation layer. */
export type DictationStatus = "idle" | "recording" | "transcribing";

/**
 * Subscribe to dictation pipeline status changes. Fires on every
 * transition between idle / recording / transcribing — driven by the
 * long-press hotkey, mic open, and whisper inference.
 */
export function listenDictationStatus(
  cb: (status: DictationStatus) => void,
): Promise<UnlistenFn> {
  return listen<DictationStatus>("dictation:status", (e) => cb(e.payload));
}

export type { ModelDto, DictationStateDto, DownloadProgressDto, PathsDto };
