/**
 * Typed wrappers around the `markdown_*` Tauri commands.
 *
 * DTO shapes mirror `src-tauri/src/commands/markdown.rs`. Field names
 * use camelCase because the Rust layer applies
 * `#[serde(rename_all = "camelCase")]`.
 */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

// ────────────────────────────────────────────────────────────────────────
// Domain types
// ────────────────────────────────────────────────────────────────────────

/** What sort of leaf this item is — drives icon + click behaviour. */
export type MarkdownItemKind = "markdown" | "image" | "directory";

/** Flowstate-style content-search options.  Field names match the
 *  camelCase the Rust DTO expects (`#[serde(rename_all = "camelCase")]`). */
export interface ContentSearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  /** Glob patterns to *include*; empty = all. */
  includes: string[];
  /** Glob patterns to *exclude*. */
  excludes: string[];
}

/** One row inside a content-search match block. */
export interface BlockLine {
  /** 1-based line number. */
  line: number;
  /** Line text (capped at 240 chars + ellipsis). */
  text: string;
  /** `true` for a match line, `false` for surrounding context. */
  isMatch: boolean;
}

/** Contiguous run of matching + context lines from a single file. */
export interface ContentBlock {
  /** Absolute filesystem path. */
  path: string;
  /** 1-based line of the first row in `lines`. */
  startLine: number;
  /** Match + context lines, in document order. */
  lines: BlockLine[];
}

/** One file/dir entry in a vault's pre-order DFS list. */
export interface MarkdownFileItem {
  /** Display name (basename — `notes.md`, `Daily Notes`, …). */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** `true` for directories. */
  isDir: boolean;
  /** Indent depth — `0` is a top-level child of the vault root. */
  depth: number;
  /** Coarse kind discriminator. */
  kind: MarkdownItemKind;
}

/** One vault's slice of the discovered tree. */
export interface MarkdownVaultDto {
  /** Absolute path of the vault root. */
  root: string;
  /** Basename of the root, used as the section header. */
  name: string;
  /** Pre-order DFS list of files + directories under this root. */
  items: MarkdownFileItem[];
}

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

export const markdownTauri = {
  /** Read the persisted vault list. */
  listVaults: () => invoke<string[]>("markdown_list_vaults"),

  /** Push a vault folder onto the list. Returns the updated list. */
  addVault: (path: string) => invoke<string[]>("markdown_add_vault", { path }),

  /** Remove a vault by exact path match. Returns the updated list. */
  removeVault: (path: string) =>
    invoke<string[]>("markdown_remove_vault", { path }),

  /** Walk every vault and return its `.md` tree. */
  discoverFiles: (vaults: string[]) =>
    invoke<MarkdownVaultDto[]>("markdown_discover_files", { vaults }),

  /** Read the persisted recent-files ring (most recent first). */
  recentFiles: () => invoke<string[]>("markdown_recent_files"),

  /** Push `path` to the front of the ring. Returns the updated ring. */
  pushRecent: (path: string) =>
    invoke<string[]>("markdown_push_recent", { path }),

  /**
   * Save a clipboard-pasted image next to the open document. Returns
   * the *relative path from `targetDir`* the editor should embed in
   * `![…](…)`.
   */
  savePastedImage: (targetDir: string, fileName: string, bytes: Uint8Array) =>
    invoke<string>("markdown_save_pasted_image", {
      targetDir,
      fileName,
      // Tauri's `invoke` serialises `Uint8Array` via `Vec<u8>` JSON
      // (a flat number array) — converting up-front avoids a per-call
      // surprise about type compatibility.
      bytes: Array.from(bytes),
    }),

  /** Read a `.md` file's contents (reuses the existing parse command). */
  readFile: (path: string) => invoke<string>("read_file_content", { path }),

  /** Write a `.md` file's contents (reuses the existing parse command). */
  writeFile: (path: string, content: string) =>
    invoke<void>("write_file_content", { path, content }),

  /** Native folder picker (re-uses the http-runner backend command). */
  pickDirectory: () => invoke<string | null>("pick_directory"),

  /** Create an empty markdown file in `parentDir`.  `name` may include
   *  or omit the `.md` extension; the backend ensures it's there. */
  createFile: (parentDir: string, name: string) =>
    invoke<string>("markdown_create_file", { parentDir, name }),

  /** Create an empty directory under `parentDir`. */
  createDir: (parentDir: string, name: string) =>
    invoke<string>("markdown_create_dir", { parentDir, name }),

  /** Rename a file or directory in place.  `newName` is a basename. */
  rename: (oldPath: string, newName: string) =>
    invoke<string>("markdown_rename", { oldPath, newName }),

  /** Move to the OS trash (recoverable). */
  deleteToTrash: (path: string) =>
    invoke<void>("markdown_delete_to_trash", { path }),

  /**
   * Grep across every `.md` in `vaults`.  `token` is a frontend-minted
   * monotonic id; pass it back to `stopContentSearch` to abort an
   * in-flight call.
   */
  searchContents: (
    vaults: string[],
    query: string,
    options: ContentSearchOptions,
    token: number,
  ) =>
    invoke<ContentBlock[]>("markdown_search_contents", {
      vaults,
      query,
      options,
      token,
    }),

  /** Cancel the content search identified by `token`. */
  stopContentSearch: (token: number) =>
    invoke<void>("markdown_stop_content_search", { token }),
};

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve a local file path to a webview-loadable URL.  The Tauri
 * asset protocol exposes whitelisted folders to the webview; callers
 * embed this URL in `<img src=…>` to render images during Live
 * Preview.
 */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/** Extract the basename (no extension) of a `.md` path. */
export function basenameNoExt(path: string): string {
  const last = path.split("/").pop() ?? path;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Parent directory of an absolute path. Returns `""` when none. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

/** A loose slug: lowercase, ascii letters/digits/dash, collapsed. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
