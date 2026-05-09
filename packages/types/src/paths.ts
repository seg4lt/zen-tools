/**
 * Pure POSIX-style path helpers shared across the workspace.
 *
 * These started life inside `src/tools/markdown/lib/tauri.ts` because
 * the Markdown tool needed them first, but they have **zero** Tauri
 * IPC dependency — every function is a pure string transform — so they
 * shouldn't live in a tool's `lib/`. Lifting them here lets any future
 * tool (and the asset-protocol resolver in particular) reuse them
 * without dragging the markdown tool's surface in.
 *
 * All functions assume forward-slash separators. The Tauri host on
 * macOS / Linux gives us POSIX paths verbatim; Windows callers should
 * normalise back-slashes before invoking these.
 */

/** Extract the basename (no extension) of a path. */
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

/** `true` when `path` is an Excalidraw drawing — either the SVG or
 *  PNG flavour (both formats embed the scene in a metadata block
 *  excalidraw can round-trip).  Centralised here so the sidebar,
 *  view-plugin, link-open handler, and store all agree on what
 *  counts as a drawing without each rolling its own regex. */
export function isExcalidrawPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".excalidraw.svg") || lower.endsWith(".excalidraw.png");
}

/** `true` when `path` is an HTML document. The viewer mounts a
 *  Code/Preview split for these instead of the plain text editor — see
 *  `HtmlEditor` in the markdown tool. */
export function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/** `true` when `path` is one of the markdown formats the vault walker
 *  and editor treat as markdown rather than a generic text file. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdown") ||
    lower.endsWith(".mkd")
  );
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
