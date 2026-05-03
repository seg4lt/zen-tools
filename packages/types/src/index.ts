/**
 * Placeholder for the `@zen-tools/types` package.
 *
 * Pending move (Phase 3.5):
 * - Shared TS enum-style types (HttpMethod, FileType, …) currently
 *   hand-mirrored across each tool's lib/tauri.ts.
 * - Pure path utilities from `src/tools/markdown/lib/tauri.ts`:
 *   posixRelative, normalizePath, basenameNoExt, basename, dirname,
 *   slugify, isExcalidrawPath.
 *
 * `@zen-tools/ipc` already owns the shared `Preferences` type. This
 * package will own the rest.
 *
 * Until the migration lands this package exists only to reserve the
 * workspace slot.
 */
export {};
