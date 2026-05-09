//! Thin wrapper around [`zen_shell::ShellExecutor`] that targets the
//! local `git` CLI with a per-invocation working-directory and a
//! generous 5-minute timeout (history walks of large repos easily run
//! past the 60 s default).

use std::path::Path;
use std::time::Duration;

use zen_shell::{ShellExecutor, ShellOutput};

use crate::error::{GitError, GitResult};

/// Default timeout used for every `git` invocation. Larger than the
/// `zen-shell` default because `git log -G` / `git log -S` over a deep
/// history can legitimately take a while.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(300);

/// Build a shell executor pre-configured for `git` calls.
pub fn build_executor() -> ShellExecutor {
    ShellExecutor::new().with_timeout(GIT_TIMEOUT)
}

/// Run `git args…` inside `repo`, capturing stdout. Returns
/// [`GitError::Shell`] on non-zero exit / missing binary / timeout.
pub async fn git(exec: &ShellExecutor, repo: &Path, args: &[&str]) -> GitResult<String> {
    let out: ShellOutput = exec.run_in_dir(repo, "git", args).await?;
    Ok(out.stdout)
}

/// Run `git args…` and return the *trimmed* stdout — useful for
/// `git rev-parse` style calls that emit a single token + newline.
pub async fn git_trimmed(
    exec: &ShellExecutor,
    repo: &Path,
    args: &[&str],
) -> GitResult<String> {
    git(exec, repo, args).await.map(|s| s.trim().to_string())
}

/// Resolve the absolute path to the repository's `.git` directory
/// (works for main worktrees, linked worktrees, and bare repos).
pub async fn git_dir(exec: &ShellExecutor, repo: &Path) -> GitResult<std::path::PathBuf> {
    let raw = git_trimmed(exec, repo, &["rev-parse", "--git-dir"]).await?;
    let p = std::path::Path::new(&raw);
    if p.is_absolute() {
        Ok(p.to_path_buf())
    } else {
        Ok(repo.join(p))
    }
}

/// Verify that `repo` is a git working tree. Returns
/// [`GitError::NotARepo`] otherwise.
pub async fn ensure_repo(exec: &ShellExecutor, repo: &Path) -> GitResult<()> {
    let raw = exec
        .run_in_dir(repo, "git", &["rev-parse", "--is-inside-work-tree"])
        .await;
    match raw {
        Ok(out) if out.stdout.trim() == "true" => Ok(()),
        _ => Err(GitError::NotARepo(repo.to_path_buf())),
    }
}
