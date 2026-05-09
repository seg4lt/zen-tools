//! Conflict enumeration + per-file 3-blob retrieval.
//!
//! We use `git ls-files --unmerged -z` (rather than
//! `git status --porcelain=v2`) so the parser is straightforward and
//! deterministic across git versions:
//!
//! ```text
//!   <mode> SP <oid> SP <stage> '\t' <path> NUL
//! ```
//!
//! Each unmerged path appears once per surviving stage (1 = base,
//! 2 = ours/HEAD, 3 = theirs/incoming). We dedupe by path and infer
//! the conflict status from which stages are present.

use std::collections::BTreeMap;
use std::path::Path;

use zen_shell::ShellExecutor;

use crate::error::GitResult;
use crate::models::merge::{ConflictBlobs, ConflictFile, ConflictStatus};
use crate::shell;

/// Every path the index has marked unmerged.
pub async fn list_unmerged(exec: &ShellExecutor, repo: &Path) -> GitResult<Vec<ConflictFile>> {
    let stdout = shell::git(exec, repo, &["ls-files", "--unmerged", "-z"]).await?;

    // path → [_, has_stage1, has_stage2, has_stage3]
    let mut paths: BTreeMap<String, [bool; 4]> = BTreeMap::new();

    for entry in stdout.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let Some(tab) = entry.find('\t') else {
            continue;
        };
        let header = &entry[..tab];
        let path = entry[tab + 1..].to_string();
        let parts: Vec<&str> = header.split(' ').collect();
        if parts.len() < 3 {
            continue;
        }
        let stage: usize = parts[2].parse().unwrap_or(0);
        if (1..=3).contains(&stage) {
            paths.entry(path).or_default()[stage] = true;
        }
    }

    let mut out = Vec::with_capacity(paths.len());
    for (path, stages) in paths {
        let s1 = stages[1];
        let s2 = stages[2];
        let s3 = stages[3];
        let status = match (s1, s2, s3) {
            (true, true, true) => ConflictStatus::BothModified,
            (false, true, true) => ConflictStatus::BothAdded,
            (true, true, false) => ConflictStatus::DeletedByThem,
            (true, false, true) => ConflictStatus::DeletedByUs,
            (false, true, false) => ConflictStatus::AddedByUs,
            (false, false, true) => ConflictStatus::AddedByThem,
            _ => ConflictStatus::Other,
        };
        let binary = is_binary(exec, repo, &path).await.unwrap_or(false);
        out.push(ConflictFile {
            path,
            status,
            binary,
        });
    }
    Ok(out)
}

/// Stage 1/2/3 blobs for `path` plus the current worktree contents.
pub async fn conflict_blobs(
    exec: &ShellExecutor,
    repo: &Path,
    path: &str,
) -> GitResult<ConflictBlobs> {
    let base = stage_blob(exec, repo, 1, path).await;
    let local = stage_blob(exec, repo, 2, path).await;
    let remote = stage_blob(exec, repo, 3, path).await;
    let working = std::fs::read_to_string(repo.join(path)).ok();
    let binary = is_binary(exec, repo, path).await.unwrap_or(false);
    Ok(ConflictBlobs {
        base,
        local,
        remote,
        working,
        binary,
    })
}

async fn stage_blob(
    exec: &ShellExecutor,
    repo: &Path,
    stage: u8,
    path: &str,
) -> Option<String> {
    let target = format!(":{}:{}", stage, path);
    shell::git(exec, repo, &["show", &target]).await.ok()
}

async fn is_binary(exec: &ShellExecutor, repo: &Path, path: &str) -> GitResult<bool> {
    // `git check-attr binary -- <path>` returns lines like "<path>: binary: set".
    // Cheap, no I/O on the blob itself.
    let stdout = shell::git(exec, repo, &["check-attr", "binary", "--", path]).await?;
    Ok(stdout.contains(": binary: set"))
}
