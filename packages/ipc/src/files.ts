/**
 * Cross-tool file IPC: native folder picker + raw read/write of file
 * contents. Three tools (HTTP runner, Markdown, Database Explorer / SQL
 * workspace) share these calls; they used to live in `http-runner`'s
 * private `lib/tauri.ts` which forced cross-tool imports.
 */

import { invoke } from "@tauri-apps/api/core";

/** Show a native directory picker. Returns `null` on cancel. */
export function pickDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_directory");
}

/** Read a UTF-8 file's contents. */
export function readFileContent(path: string): Promise<string> {
  return invoke<string>("read_file_content", { path });
}

/** Write a UTF-8 file's contents (creates / truncates). */
export function writeFileContent(path: string, content: string): Promise<void> {
  return invoke<void>("write_file_content", { path, content });
}
