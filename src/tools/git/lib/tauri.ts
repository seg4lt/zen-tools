/**
 * Typed wrappers around the `git_*` Tauri commands. Shapes mirror the
 * Rust DTOs in `src-tauri/src/commands/git.rs` and the `zen-git` crate.
 *
 * Every command takes plain JSON-serialisable arguments; the camelCase
 * field names match the `#[serde(rename_all = "camelCase")]` attrs on
 * the Rust side.
 */

import { invoke } from "@tauri-apps/api/core";

// ────────────────────────────────────────────────────────────────────────
// Domain types
// ────────────────────────────────────────────────────────────────────────

export interface RepoEntry {
  path: string;
  label: string;
  addedAt: string;
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  subject: string;
  body: string;
  refs: string[];
}

export interface BranchRef {
  name: string;
  fullName: string;
  isHead: boolean;
  isRemote: boolean;
  tip: string;
}

export type FileChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "Other";

export interface FileChange {
  status: FileChangeStatus;
  path: string;
  fromPath?: string;
}

export interface FileDiff {
  path: string;
  fromPath?: string;
  status: FileChangeStatus;
  patch: string;
  binary: boolean;
}

export type TextScope = "message" | "changes" | "changesRegex";

export interface TextSearch {
  query: string;
  scope: TextScope;
  caseSensitive: boolean;
  regex: boolean;
}

export interface CommitLogFilter {
  branch?: string;
  author?: string;
  since?: string;
  until?: string;
  path?: string;
  text?: TextSearch;
  mergesOnly?: boolean;
  noMerges?: boolean;
  hashPrefix?: string;
  skip?: number;
  limit?: number;
}

export type MergeKind =
  | "merge"
  | "rebase"
  | "cherryPick"
  | "revert"
  | "none";

export interface MergeState {
  kind: MergeKind;
  head: string | null;
  incoming: string | null;
  unresolved: number;
}

export type ConflictStatus =
  | "bothModified"
  | "bothAdded"
  | "deletedByUs"
  | "deletedByThem"
  | "addedByUs"
  | "addedByThem"
  | "other";

export interface ConflictFile {
  path: string;
  status: ConflictStatus;
  binary: boolean;
}

export interface ConflictBlobs {
  base: string | null;
  local: string | null;
  remote: string | null;
  working: string | null;
  binary: boolean;
}

export interface MergePreview {
  into: string;
  from: string;
  fastForward: boolean;
  conflicts: string[];
  incomingCommits: Commit[];
  filesChanged: string[];
}

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

export const gitTauri = {
  // ── Repos ─────────────────────────────────────────────────────────────
  listRepos: () => invoke<RepoEntry[]>("git_list_repos"),
  addRepo: (path: string, label?: string | null) =>
    invoke<RepoEntry>("git_add_repo", { path, label: label ?? null }),
  pickAndAddRepo: () =>
    invoke<RepoEntry | null>("git_pick_and_add_repo"),
  removeRepo: (path: string) => invoke<void>("git_remove_repo", { path }),
  relabelRepo: (path: string, label: string) =>
    invoke<boolean>("git_relabel_repo", { path, label }),

  // ── Log ───────────────────────────────────────────────────────────────
  listCommits: (repo: string, filter: CommitLogFilter) =>
    invoke<Commit[]>("git_list_commits", { repo, filter }),
  countCommits: (repo: string, filter: CommitLogFilter) =>
    invoke<number>("git_count_commits", { repo, filter }),
  listBranches: (repo: string) =>
    invoke<BranchRef[]>("git_list_branches", { repo }),
  listAuthors: (repo: string, limit?: number) =>
    invoke<string[]>("git_list_authors", { repo, limit: limit ?? null }),

  // ── Commit details ────────────────────────────────────────────────────
  commitFiles: (repo: string, rev: string) =>
    invoke<FileChange[]>("git_commit_files", { repo, rev }),
  commitDiff: (repo: string, rev: string, path: string) =>
    invoke<FileDiff>("git_commit_diff", { repo, rev, path }),
  fileAtRev: (repo: string, rev: string, path: string) =>
    invoke<string>("git_file_at_rev", { repo, rev, path }),
  rangeDiffFiles: (repo: string, from: string, to: string) =>
    invoke<FileChange[]>("git_range_diff_files", { repo, from, to }),
  rangeDiffFile: (repo: string, from: string, to: string, path: string) =>
    invoke<FileDiff>("git_range_diff_file", { repo, from, to, path }),

  // ── Merge state / conflicts ───────────────────────────────────────────
  mergeState: (repo: string) =>
    invoke<MergeState>("git_merge_state", { repo }),
  listConflicts: (repo: string) =>
    invoke<ConflictFile[]>("git_list_conflicts", { repo }),
  conflictBlobs: (repo: string, path: string) =>
    invoke<ConflictBlobs>("git_conflict_blobs", { repo, path }),
  writeResolved: (repo: string, path: string, content: string) =>
    invoke<void>("git_write_resolved", { repo, path, content }),
  stagePath: (repo: string, path: string) =>
    invoke<void>("git_stage_path", { repo, path }),
  unstagePath: (repo: string, path: string) =>
    invoke<void>("git_unstage_path", { repo, path }),

  // ── Merge ops ─────────────────────────────────────────────────────────
  previewMerge: (repo: string, into: string, from: string) =>
    invoke<MergePreview>("git_preview_merge", { repo, into, from }),
  continueOp: (repo: string) => invoke<void>("git_continue_op", { repo }),
  abortOp: (repo: string) => invoke<void>("git_abort_op", { repo }),
  skipOp: (repo: string) => invoke<void>("git_skip_op", { repo }),
};
