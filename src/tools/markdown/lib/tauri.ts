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
export type MarkdownItemKind =
  | "markdown"
  | "image"
  | "directory"
  // Excalidraw drawings — files named `*.excalidraw.svg` carry an
  // embedded scene we can re-open in the drawing pane.  The Rust
  // walker emits this kind explicitly; the matching branch sits
  // *before* the generic `image` branch so plain SVGs still get
  // `kind: "image"`.
  | "excalidraw";

/** Flowstate-style content-search options.  Field names match the
 *  camelCase the Rust DTO expects (`#[serde(rename_all = "camelCase")]`). */
export interface ContentSearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  /** All-words fuzzy match (case-insensitive, order-free).  Disables
   *  `useRegex` + `caseSensitive` when on. */
  useFuzzy: boolean;
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

  /**
   * File fuzzy search across every supplied vault, backed by
   * `fff-search`'s `FilePicker::fuzzy_search`.  Returns up to ~200
   * ranked **absolute paths**.  Empty query → every indexed path
   * (frontend orders by recents); non-empty query → ranked.
   *
   * `currentFile` is an optional ranking boost: paths near the
   * active document score higher.  Pass the active tab's path; the
   * backend tolerates `null` for fire-and-forget calls.
   */
  searchFiles: (
    vaults: string[],
    query: string,
    currentFile: string | null,
  ) =>
    invoke<string[]>("markdown_search_files", {
      vaults,
      query,
      currentFile,
    }),
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

/** Full basename — used by the header label for non-`.md` tabs (e.g.
 *  `Sketch.excalidraw.svg`) where stripping the extension would lose
 *  meaningful information. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Parent directory of an absolute path. Returns `""` when none. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

/**
 * Compute the POSIX-style path of `target` relative to `from`
 * (a directory).  Used by the markdown link autocomplete so a
 * suggested file gets inserted as `path/to/file.md` rather than its
 * absolute path.  Falls back to `target` unchanged when the inputs
 * aren't both absolute (preserves Windows / non-rooted paths
 * harmlessly).
 *
 * Behaviour mirrors `path.posix.relative`:
 *   - Same dir → `file.md`
 *   - Subdir   → `subdir/file.md`
 *   - Parent   → `../file.md`
 *   - No common prefix → returns `target` unchanged.
 */
export function posixRelative(from: string, target: string): string {
  if (!from.startsWith("/") || !target.startsWith("/")) return target;
  const a = normalizePath(from).split("/").filter(Boolean);
  const b = normalizePath(target).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ups = a.length - i;
  const rest = b.slice(i);
  if (ups === 0 && rest.length === 0) return ".";
  const parts: string[] = [];
  for (let k = 0; k < ups; k++) parts.push("..");
  parts.push(...rest);
  return parts.join("/");
}

/**
 * Collapse `.` / `..` segments and double-slashes in a POSIX-style
 * absolute path.  Used by every code path that opens a file so the
 * "is this already a tab?" identity check does string-equality on
 * canonical paths — otherwise `[foo](./foo.md)` resolved against
 * `/dir/bar.md` would produce `/dir/./foo.md`, miss the existing tab
 * for `/dir/foo.md`, and open a duplicate.
 *
 * Behaviour mirrors `path.posix.normalize`:
 *   - Repeated separators collapsed (`a//b` → `a/b`).
 *   - `.` segments dropped.
 *   - `..` segments pop the previous segment when possible (won't
 *     ascend past root).
 *   - Trailing slash stripped except for the root itself.
 */
export function normalizePath(input: string): string {
  if (!input) return input;
  const isAbs = input.startsWith("/");
  const segs = input.split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (isAbs) return `/${joined}`;
  return joined || ".";
}

/** A loose slug: lowercase, ascii letters/digits/dash, collapsed. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
