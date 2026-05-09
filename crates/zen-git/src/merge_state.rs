//! Detect whether the working tree currently has a merge / rebase /
//! cherry-pick / revert in progress, and surface the "incoming" ref so
//! the UI can title the merge editor ("Merging origin/feature into main").

use std::path::Path;

use zen_shell::ShellExecutor;

use crate::error::GitResult;
use crate::models::merge::{MergeKind, MergeState};
use crate::shell;

/// Inspect `.git/` for the marker files that describe the current op.
pub async fn detect(exec: &ShellExecutor, repo: &Path) -> GitResult<MergeState> {
    let git_dir = shell::git_dir(exec, repo).await?;

    let merge_head = git_dir.join("MERGE_HEAD");
    let cherry_head = git_dir.join("CHERRY_PICK_HEAD");
    let revert_head = git_dir.join("REVERT_HEAD");
    let rebase_merge = git_dir.join("rebase-merge");
    let rebase_apply = git_dir.join("rebase-apply");

    let head_label =
        shell::git_trimmed(exec, repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .ok()
            .filter(|s| !s.is_empty());

    let unresolved = count_unresolved(exec, repo).await.unwrap_or(0);

    if merge_head.exists() {
        let incoming = read_first_line(&merge_head)
            .ok()
            .map(|sha| short_or_self(&sha));
        return Ok(MergeState {
            kind: MergeKind::Merge,
            head: head_label,
            incoming,
            unresolved,
        });
    }
    if cherry_head.exists() {
        let incoming = read_first_line(&cherry_head)
            .ok()
            .map(|sha| short_or_self(&sha));
        return Ok(MergeState {
            kind: MergeKind::CherryPick,
            head: head_label,
            incoming,
            unresolved,
        });
    }
    if revert_head.exists() {
        let incoming = read_first_line(&revert_head)
            .ok()
            .map(|sha| short_or_self(&sha));
        return Ok(MergeState {
            kind: MergeKind::Revert,
            head: head_label,
            incoming,
            unresolved,
        });
    }
    if rebase_merge.exists() || rebase_apply.exists() {
        // Both layouts have a `head-name` file with the branch being rebased.
        let incoming = std::fs::read_to_string(rebase_merge.join("head-name"))
            .or_else(|_| std::fs::read_to_string(rebase_apply.join("head-name")))
            .ok()
            .map(|s| s.trim().trim_start_matches("refs/heads/").to_string());
        return Ok(MergeState {
            kind: MergeKind::Rebase,
            head: head_label,
            incoming,
            unresolved,
        });
    }

    Ok(MergeState {
        kind: MergeKind::None,
        head: head_label,
        incoming: None,
        unresolved: 0,
    })
}

async fn count_unresolved(exec: &ShellExecutor, repo: &Path) -> GitResult<u32> {
    let stdout = shell::git(exec, repo, &["ls-files", "--unmerged"]).await?;
    let mut paths = std::collections::BTreeSet::new();
    for line in stdout.lines() {
        if let Some(tab) = line.find('\t') {
            paths.insert(line[tab + 1..].to_string());
        }
    }
    Ok(paths.len() as u32)
}

fn read_first_line(path: &Path) -> std::io::Result<String> {
    let s = std::fs::read_to_string(path)?;
    Ok(s.lines().next().unwrap_or("").trim().to_string())
}

fn short_or_self(sha: &str) -> String {
    sha.chars().take(7).collect()
}
