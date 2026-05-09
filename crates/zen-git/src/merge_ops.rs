//! High-level merge operations: pre-merge preview (no worktree
//! mutation), continue / abort / skip the in-progress op, and the
//! per-file write+stage helpers used by the 3-way editor.

use std::path::Path;

use zen_shell::{ShellError, ShellExecutor};

use crate::error::{GitError, GitResult};
use crate::log::list_commits;
use crate::models::filter::CommitLogFilter;
use crate::models::merge::{MergeKind, MergePreview};
use crate::shell;

/// Trial-merge `from` into `into` without touching the worktree, using
/// `git merge-tree --write-tree --name-only` (git ≥ 2.38). Returns the
/// predicted conflict list, the changed file list, and the commits in
/// `from` that aren't yet in `into`.
pub async fn preview_merge(
    exec: &ShellExecutor,
    repo: &Path,
    into: &str,
    from: &str,
) -> GitResult<MergePreview> {
    // Fast-forward classification: empty `merge-base --is-ancestor`
    // exit code → fast-forward possible.
    let fast_forward = match exec
        .run_in_dir(repo, "git", &["merge-base", "--is-ancestor", into, from])
        .await
    {
        Ok(_) => true,
        Err(ShellError::CommandFailed { .. }) => false,
        Err(e) => return Err(GitError::Shell(e)),
    };

    // Trial merge. Newer git versions support `--name-only` which lists
    // changed files; conflicts surface as a non-zero exit with the
    // conflict info on stdout. We tolerate either shape.
    let merge_tree = exec
        .run_in_dir(
            repo,
            "git",
            &["merge-tree", "--write-tree", "--name-only", into, from],
        )
        .await;
    let (files_changed, conflicts) = match merge_tree {
        Ok(out) => parse_merge_tree_ok(&out.stdout),
        Err(ShellError::CommandFailed { output, .. }) => parse_merge_tree_conflict(&output),
        Err(e) => return Err(GitError::Shell(e)),
    };

    let incoming_commits = list_commits(
        exec,
        repo,
        &CommitLogFilter {
            branch: Some(format!("{into}..{from}")),
            limit: 100,
            ..Default::default()
        },
    )
    .await
    .unwrap_or_default();

    Ok(MergePreview {
        into: into.to_string(),
        from: from.to_string(),
        fast_forward,
        conflicts,
        incoming_commits: clip(incoming_commits, 100),
        files_changed,
    })
}

/// Write `content` to `<repo>/<path>` and stage it via `git add`.
pub async fn write_resolved(
    exec: &ShellExecutor,
    repo: &Path,
    path: &str,
    content: &str,
) -> GitResult<()> {
    let abs = repo.join(path);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&abs, content.as_bytes())?;
    shell::git(exec, repo, &["add", "--", path]).await?;
    Ok(())
}

/// `git add -- <path>` — stage a path verbatim (without rewriting it).
pub async fn stage_path(exec: &ShellExecutor, repo: &Path, path: &str) -> GitResult<()> {
    shell::git(exec, repo, &["add", "--", path]).await?;
    Ok(())
}

/// `git restore --staged -- <path>` — unstage.
pub async fn unstage_path(exec: &ShellExecutor, repo: &Path, path: &str) -> GitResult<()> {
    shell::git(exec, repo, &["restore", "--staged", "--", path]).await?;
    Ok(())
}

/// Continue the in-progress op. Sets `GIT_EDITOR=true` so git won't
/// pop up an editor for the merge commit message.
pub async fn continue_op(exec: &ShellExecutor, repo: &Path, kind: MergeKind) -> GitResult<()> {
    let arg = continue_arg(kind)?;
    // `--continue` for merge / rebase / cherry-pick / revert all want
    // a non-interactive editor when they need to compose a commit.
    let exec = exec.clone().with_path("/usr/bin"); // ensure `true` is on PATH
    let stdout = exec
        .run_in_dir(repo, "git", &["-c", "core.editor=true", arg.0, arg.1])
        .await?;
    let _ = stdout;
    Ok(())
}

/// Abort the in-progress op.
pub async fn abort_op(exec: &ShellExecutor, repo: &Path, kind: MergeKind) -> GitResult<()> {
    let arg = abort_arg(kind)?;
    shell::git(exec, repo, &[arg.0, arg.1]).await?;
    Ok(())
}

/// Skip the current step (rebase / cherry-pick / revert only).
pub async fn skip_op(exec: &ShellExecutor, repo: &Path, kind: MergeKind) -> GitResult<()> {
    let arg = skip_arg(kind)?;
    shell::git(exec, repo, &[arg.0, arg.1]).await?;
    Ok(())
}

fn continue_arg(kind: MergeKind) -> GitResult<(&'static str, &'static str)> {
    match kind {
        MergeKind::Merge => Ok(("merge", "--continue")),
        MergeKind::Rebase => Ok(("rebase", "--continue")),
        MergeKind::CherryPick => Ok(("cherry-pick", "--continue")),
        MergeKind::Revert => Ok(("revert", "--continue")),
        MergeKind::None => Err(GitError::NoOpInProgress),
    }
}

fn abort_arg(kind: MergeKind) -> GitResult<(&'static str, &'static str)> {
    match kind {
        MergeKind::Merge => Ok(("merge", "--abort")),
        MergeKind::Rebase => Ok(("rebase", "--abort")),
        MergeKind::CherryPick => Ok(("cherry-pick", "--abort")),
        MergeKind::Revert => Ok(("revert", "--abort")),
        MergeKind::None => Err(GitError::NoOpInProgress),
    }
}

fn skip_arg(kind: MergeKind) -> GitResult<(&'static str, &'static str)> {
    match kind {
        MergeKind::Rebase => Ok(("rebase", "--skip")),
        MergeKind::CherryPick => Ok(("cherry-pick", "--skip")),
        MergeKind::Revert => Ok(("revert", "--skip")),
        MergeKind::Merge => Err(GitError::SkipNotSupported),
        MergeKind::None => Err(GitError::NoOpInProgress),
    }
}

/// Newer `git merge-tree --write-tree --name-only` exits 0 with one
/// changed-path per line on stdout when the merge is clean.
fn parse_merge_tree_ok(stdout: &str) -> (Vec<String>, Vec<String>) {
    let files: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        // First line is the resulting tree OID — drop it if it looks
        // like a 40-char hex.
        .filter(|l| !is_oid(l))
        .map(|l| l.to_string())
        .collect();
    (files, Vec::new())
}

/// On conflict the same call exits non-zero and prints a sectioned
/// report; conflicting paths show up after the tree OID. We extract
/// every line that starts with "CONFLICT" or that follows the
/// "<<changed file paths>>" hint git emits.
fn parse_merge_tree_conflict(stderr_or_stdout: &str) -> (Vec<String>, Vec<String>) {
    let mut conflicts = Vec::new();
    let mut files = Vec::new();
    for line in stderr_or_stdout.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("CONFLICT ") {
            // git uses formats like "CONFLICT (content): Merge conflict in foo.txt".
            if let Some(idx) = rest.find(" in ") {
                conflicts.push(rest[idx + 4..].trim().to_string());
            }
        } else if !is_oid(line) && !line.starts_with("Auto-merging ") {
            files.push(line.to_string());
        }
    }
    conflicts.sort();
    conflicts.dedup();
    (files, conflicts)
}

fn is_oid(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn clip<T>(mut v: Vec<T>, n: usize) -> Vec<T> {
    if v.len() > n {
        v.truncate(n);
    }
    v
}

