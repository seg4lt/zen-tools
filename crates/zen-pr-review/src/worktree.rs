//! Detached worktree management for AI reviews.
//!
//! A review must run against the exact commit GitHub thinks is the
//! PR head, regardless of whatever state the user has locally in their
//! clone (dirty index, branch checked out elsewhere, behind on origin,
//! …). We solve that with a persistent per-PR detached worktree pinned
//! to the latest reviewed head SHA.
//!
//! Path layout is `<root>/<owner>__<repo>__<number>/`. It stays stable
//! across pushes so the user can keep the directory open in an IDE,
//! then is force-removed when the PR leaves the open-PR lists.

use std::path::{Path, PathBuf};
use std::time::Duration;

use zen_shell::ShellExecutor;

use crate::error::{ReviewError, ReviewResult};

/// Build a [`ShellExecutor`] suitable for `git fetch` / `git worktree`
/// calls. Five-minute timeout to cover initial fetches on big repos.
pub fn build_git_executor() -> ShellExecutor {
    ShellExecutor::new().with_timeout(Duration::from_secs(300))
}

/// Compute the stable deterministic worktree path for a PR.
pub fn worktree_path(root: &Path, owner: &str, repo: &str, number: u64) -> PathBuf {
    root.join(format!("{owner}__{repo}__{number}"))
}

/// Find feature-owned worktrees in `root`, including the legacy
/// `<pr>__<short_sha>` layout, and recover their PR identities.
pub fn managed_worktrees(root: &Path) -> ReviewResult<Vec<(crate::PrKey, PathBuf)>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut worktrees = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some(pr) = parse_worktree_name(&name) {
            worktrees.push((pr, entry.path()));
        }
    }
    Ok(worktrees)
}

fn parse_worktree_name(name: &str) -> Option<crate::PrKey> {
    let (owner, remainder) = name.split_once("__")?;
    if owner.is_empty() {
        return None;
    }
    let (repo_and_number, last) = remainder.rsplit_once("__")?;
    let (repo, number_str) = if last.parse::<u64>().is_ok() {
        (repo_and_number, last)
    } else {
        if !(7..=64).contains(&last.len()) || !last.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        repo_and_number.rsplit_once("__")?
    };
    if repo.is_empty() {
        return None;
    }
    Some(crate::PrKey {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number: number_str.parse().ok()?,
    })
}

/// Prepare a worktree for the review.
///
/// 1. `git fetch origin <head_branch> <base_branch>` so we have the
///    commit (the PR head may not yet be in the user's local clone).
/// 2. If the persistent worktree already exists, hard-reset it to
///    `head_sha` and remove every untracked/ignored file. This directory
///    is disposable review state, never a user working copy.
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
            Ok(existing) => {
                tracing::info!(
                    target_path = %target.display(),
                    previous_head_sha = existing,
                    head_sha,
                    "resetting persistent review worktree to requested head sha"
                );
                // Clean first so an untracked path cannot obstruct files
                // introduced by the requested commit.
                exec.run_in_dir(target, "git", &["clean", "-ffdx"])
                    .await?;
                exec.run_in_dir(target, "git", &["reset", "--hard", head_sha])
                    .await?;
                // Reset does not remove every unrelated untracked path.
                exec.run_in_dir(target, "git", &["clean", "-ffdx"])
                    .await?;
                return Ok(());
            }
            Err(e) => {
                tracing::warn!(?e, target_path = %target.display(), "invalid stale worktree; recreating");
                let _ = remove_worktree(exec, local_repo, target).await;
                if target.exists() {
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
                tokio::fs::remove_dir_all(target).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn worktree_path_is_stable_for_the_pr() {
        let p = worktree_path(Path::new("/tmp/reviews"), "octocat", "demo", 42);
        assert!(p.ends_with("octocat__demo__42"));
    }

    #[test]
    fn parses_stable_and_legacy_worktree_names() {
        let stable = parse_worktree_name("octocat__demo_repo__42").unwrap();
        assert_eq!(stable.slug(), "octocat/demo_repo#42");

        let legacy = parse_worktree_name("octocat__demo_repo__42__abcdef012345").unwrap();
        assert_eq!(legacy, stable);
        assert!(parse_worktree_name("some-unrelated-folder").is_none());
        assert!(parse_worktree_name("octocat__demo__42__not-a-sha").is_none());
    }

    #[tokio::test]
    async fn persistent_worktree_discards_changes_and_moves_to_exact_sha() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let target = temp.path().join("reviews").join("octocat__demo__42");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join(".gitignore"), "*.ignored\n").unwrap();
        std::fs::write(repo.join("review.txt"), "old\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "old"]);
        let old_sha = git(&repo, &["rev-parse", "HEAD"]);

        std::fs::write(repo.join("review.txt"), "new\n").unwrap();
        git(&repo, &["commit", "-qam", "new"]);
        let new_sha = git(&repo, &["rev-parse", "HEAD"]);

        let exec = build_git_executor();
        prepare_worktree(&exec, &repo, None, None, &old_sha, &target)
            .await
            .unwrap();
        std::fs::write(target.join("review.txt"), "local edit\n").unwrap();
        std::fs::write(target.join("scratch.txt"), "untracked\n").unwrap();
        std::fs::write(target.join("build.ignored"), "ignored\n").unwrap();

        prepare_worktree(&exec, &repo, None, None, &new_sha, &target)
            .await
            .unwrap();

        assert_eq!(git(&target, &["rev-parse", "HEAD"]), new_sha);
        assert_eq!(std::fs::read_to_string(target.join("review.txt")).unwrap(), "new\n");
        assert!(!target.join("scratch.txt").exists());
        assert!(!target.join("build.ignored").exists());
        assert!(git(&target, &["status", "--porcelain"]).is_empty());
    }
}
