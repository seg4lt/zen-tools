//! Detached worktree management for AI reviews.
//!
//! A review must run against the exact commit GitHub thinks is the
//! PR head, regardless of whatever state the user has locally in their
//! clone (dirty index, branch checked out elsewhere, behind on origin,
//! …). We solve that with a per-PR detached worktree pinned to the
//! head SHA — `git worktree add --detach <path> <sha>`.
//!
//! Path layout is `<root>/<owner>__<repo>__<number>__<short_sha>/` so
//! concurrent reviews of two different head SHAs of the same PR don't
//! collide, and so the cleanup pass can spot stale directories with a
//! single `read_dir`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use zen_shell::ShellExecutor;

use crate::error::{ReviewError, ReviewResult};

/// Build a [`ShellExecutor`] suitable for `git fetch` / `git worktree`
/// calls. Five-minute timeout to cover initial fetches on big repos.
pub fn build_git_executor() -> ShellExecutor {
    ShellExecutor::new().with_timeout(Duration::from_secs(300))
}

/// Compute the deterministic worktree path for a PR + head SHA pair.
pub fn worktree_path(root: &Path, owner: &str, repo: &str, number: u64, head_sha: &str) -> PathBuf {
    let short = head_sha.chars().take(12).collect::<String>();
    root.join(format!("{owner}__{repo}__{number}__{short}"))
}

/// Prepare a worktree for the review.
///
/// 1. `git fetch origin <head_branch> <base_branch>` so we have the
///    commit (the PR head may not yet be in the user's local clone).
/// 2. Compare the existing worktree (if any) against `head_sha`:
///    * matching → reuse;
///    * mismatch → `git worktree remove --force` then re-add.
/// 3. `git worktree add --detach <target> <head_sha>` so the user's
///    own checkout of the same branch never blocks us.
pub async fn prepare_worktree(
    exec: &ShellExecutor,
    local_repo: &Path,
    head_branch: Option<&str>,
    base_branch: Option<&str>,
    head_sha: &str,
    target: &Path,
) -> ReviewResult<()> {
    if !local_repo.exists() {
        return Err(ReviewError::LocalRepoPathMissing(local_repo.to_path_buf()));
    }
    fetch_refs(exec, local_repo, head_branch, base_branch).await?;

    if target.exists() {
        match worktree_head(exec, target).await {
            Ok(existing) if existing == head_sha => {
                tracing::debug!(
                    target_path = %target.display(),
                    head_sha,
                    "reusing existing worktree at matching head sha"
                );
                return Ok(());
            }
            _ => {
                tracing::info!(
                    target_path = %target.display(),
                    "worktree exists at a different sha; removing before recreating"
                );
                let _ = remove_worktree(exec, local_repo, target).await;
                if target.exists() {
                    // Belt-and-braces: stale dir without git registration.
                    let _ = std::fs::remove_dir_all(target);
                }
            }
        }
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    add_worktree(exec, local_repo, target, head_sha).await?;
    Ok(())
}

/// Best-effort `git worktree remove --force <path>`, falling back to
/// `std::fs::remove_dir_all` if git refuses (e.g. the worktree was
/// already pruned out of the registry).
pub async fn remove_worktree(
    exec: &ShellExecutor,
    local_repo: &Path,
    target: &Path,
) -> ReviewResult<()> {
    if !target.exists() {
        return Ok(());
    }
    let path_str = target.to_string_lossy().to_string();
    let result = exec
        .run_in_dir(
            local_repo,
            "git",
            &["worktree", "remove", "--force", &path_str],
        )
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            tracing::warn!(?e, "git worktree remove failed; falling back to rmdir");
            // Prune entries the registry might still hold for that path.
            let _ = exec
                .run_in_dir(local_repo, "git", &["worktree", "prune"])
                .await;
            if target.exists() {
                std::fs::remove_dir_all(target)?;
            }
            Ok(())
        }
    }
}

async fn fetch_refs(
    exec: &ShellExecutor,
    local_repo: &Path,
    head_branch: Option<&str>,
    base_branch: Option<&str>,
) -> ReviewResult<()> {
    let mut args: Vec<&str> = vec!["fetch", "--no-tags", "origin"];
    if let Some(hb) = head_branch {
        if !hb.is_empty() {
            args.push(hb);
        }
    }
    if let Some(bb) = base_branch {
        if !bb.is_empty() && Some(bb) != head_branch {
            args.push(bb);
        }
    }
    // Best-effort — some PRs carry refs that only exist as
    // `pull/<n>/head`. Don't fail review prep on a fetch error; the
    // worktree-add will fail with a clearer message if the SHA is
    // genuinely missing.
    if let Err(e) = exec.run_in_dir(local_repo, "git", &args).await {
        tracing::warn!(?e, "git fetch in review-prep failed (continuing)");
    }
    Ok(())
}

async fn add_worktree(
    exec: &ShellExecutor,
    local_repo: &Path,
    target: &Path,
    head_sha: &str,
) -> ReviewResult<()> {
    let target_str = target.to_string_lossy().to_string();
    exec.run_in_dir(
        local_repo,
        "git",
        &["worktree", "add", "--detach", &target_str, head_sha],
    )
    .await?;
    Ok(())
}

async fn worktree_head(exec: &ShellExecutor, target: &Path) -> ReviewResult<String> {
    let out = exec
        .run_in_dir(target, "git", &["rev-parse", "HEAD"])
        .await?;
    Ok(out.stdout.trim().to_string())
}

/// Best-effort cleanup of every worktree under `root` whose modification
/// time is older than `older_than`. Intended for app-start safety net,
/// not the primary cleanup path (that's the merged-PR purge).
pub async fn prune_stale_worktrees(
    exec: &ShellExecutor,
    local_repo: &Path,
    root: &Path,
    older_than: Duration,
) -> ReviewResult<u32> {
    let mut removed = 0u32;
    if !root.exists() {
        return Ok(removed);
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(older_than)
        .unwrap_or(std::time::UNIX_EPOCH);
    for entry in std::fs::read_dir(root)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if mtime > cutoff {
            continue;
        }
        if let Err(e) = remove_worktree(exec, local_repo, &path).await {
            tracing::warn!(?e, path = %path.display(), "stale worktree cleanup failed");
            continue;
        }
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_path_uses_short_sha_suffix() {
        let p = worktree_path(
            Path::new("/tmp/reviews"),
            "octocat",
            "demo",
            42,
            "abcdef0123456789",
        );
        assert!(p.ends_with("octocat__demo__42__abcdef012345"));
    }
}
