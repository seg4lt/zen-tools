/**
 * `@zen-tools/types` — pure TypeScript helpers and types shared
 * across the workspace.
 *
 * Today this is just the POSIX path utilities (basename, dirname,
 * normalizePath, posixRelative, slugify, isExcalidrawPath); the
 * package will grow to host other zero-IPC utilities as they're
 * lifted out of tool `lib/` directories.
 */
export {
  basename,
  basenameNoExt,
  dirname,
  isExcalidrawPath,
  normalizePath,
  posixRelative,
  slugify,
} from "./paths";
