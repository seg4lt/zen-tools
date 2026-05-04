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
/** React-Query key for the macOS TCC permissions snapshot. */
export const DICTATION_PERMISSIONS_KEY = ["dictation", "permissions"] as const;

/**
 * macOS TCC permission state for the bits dictation cares about.
 * Mirrors `src-tauri/src/dictation/commands.rs::PermissionsDto`.
 *
 * - `accessibility_granted: null` on non-macOS; `false` when the
 *   entry is missing OR explicitly denied (the two look the same to
 *   `AXIsProcessTrusted`).
 * - `microphone_status` is the richer AVCaptureDevice tri-state.
 * - The two `_deliberate_denial` booleans tell the UI whether the
 *   denied state matches a previously-observed grant ON THIS SAME
 *   install — i.e. the user revoked it on purpose and we should
 *   leave the TCC entry alone. When false, the auto-recovery flow
 *   has either already attempted a fix (and we're waiting for the
 *   user to click the system prompt) or hasn't fired yet.
 */
export type MicrophoneStatus =
  | "notDetermined"
  | "restricted"
  | "denied"
  | "authorized";

export interface PermissionsDto {
  accessibility_granted: boolean | null;
  microphone_status: MicrophoneStatus | null;
  accessibility_deliberate_denial: boolean;
  microphone_deliberate_denial: boolean;
}

/**
 * Subscribe to permission-state changes the backend has just observed
 * (e.g. the user just clicked Allow on the AVCaptureDevice prompt).
 * Lets the Settings UI re-fetch the permissions snapshot the moment
 * a grant lands instead of waiting for window focus.
 */
export function listenPermissionsChanged(
  cb: (granted: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("dictation:permissions-changed", (e) => cb(e.payload));
}

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
  // Permissions UX — recovers users stuck behind a stale TCC entry
  // that won't re-prompt (typical after an unsigned-build reinstall
  // changes the cdhash). See `src-tauri/src/dictation/permissions.rs`.
  getPermissions: (): Promise<PermissionsDto> =>
    invoke<PermissionsDto>("dictation_get_permissions"),
  /** Run `tccutil reset Accessibility <bundle>` then re-prompt. */
  resetAccessibility: (): Promise<void> =>
    invoke<void>("dictation_reset_accessibility"),
  /** Run `tccutil reset Microphone <bundle>`. */
  resetMicrophone: (): Promise<void> =>
    invoke<void>("dictation_reset_microphone"),
  /**
   * Deep-link into a System Settings privacy pane.
   * `pane` is one of `"Privacy_Accessibility"`, `"Privacy_Microphone"`.
   */
  openPrivacyPane: (pane: "Privacy_Accessibility" | "Privacy_Microphone"): Promise<void> =>
    invoke<void>("dictation_open_privacy_pane", { pane }),
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
