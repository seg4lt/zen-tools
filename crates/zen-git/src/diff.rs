//! Diff helpers: per-commit file list, per-file unified diff, blob
//! retrieval at a given revision.

use std::path::Path;

use zen_shell::ShellExecutor;

use crate::error::GitResult;
use crate::models::commit::{FileChange, FileChangeStatus, FileDiff};
use crate::shell;

/// Files changed by `rev` — `git show --name-status` parsed into
/// [`FileChange`]s. For merge commits this returns the union across
/// parents (git's default `-c` combined-diff behaviour is suppressed
/// with `-m --first-parent` to keep the list flat and clickable).
pub async fn commit_files(
    exec: &ShellExecutor,
    repo: &Path,
    rev: &str,
) -> GitResult<Vec<FileChange>> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "show",
            "--no-color",
            "-m",
            "--first-parent",
            "--name-status",
            "--pretty=",
            rev,
        ],
    )
    .await?;
    Ok(parse_name_status(&stdout))
}

/// Per-file unified diff for a single path at `rev`. Uses
/// `git show <rev> -- <path>` so we get the same diff git would write
/// to the worktree.
pub async fn commit_diff_file(
    exec: &ShellExecutor,
    repo: &Path,
    rev: &str,
    path: &str,
) -> GitResult<FileDiff> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "show",
            "--no-color",
            "-m",
            "--first-parent",
            "--pretty=",
            rev,
            "--",
            path,
        ],
    )
    .await?;
    // Recover status from the name-status pass — keeps callers from
    // having to re-issue the listing call.
    let status_stdout = shell::git(
        exec,
        repo,
        &[
            "show",
            "--no-color",
            "-m",
            "--first-parent",
            "--name-status",
            "--pretty=",
            rev,
            "--",
            path,
        ],
    )
    .await
    .unwrap_or_default();
    let mut status = FileChangeStatus::M;
    let mut from_path: Option<String> = None;
    if let Some(line) = status_stdout.lines().next() {
        let mut parts = line.splitn(3, '\t');
        if let Some(letter) = parts.next() {
            if let Some(c) = letter.chars().next() {
                status = FileChangeStatus::from_letter(c);
            }
        }
        let p1 = parts.next();
        let p2 = parts.next();
        if let (Some(a), Some(_)) = (p1, p2) {
            from_path = Some(a.to_string());
        }
    }
    let binary = stdout.contains("Binary files ") && stdout.contains(" differ");
    Ok(FileDiff {
        path: path.to_string(),
        from_path,
        status,
        patch: stdout,
        binary,
    })
}

/// Files that changed between two revisions (a "range diff"). Used by
/// the Log tab when the user multi-selects commits — we surface the
/// union of files touched between `from..to` so the side-panel tree
/// shows exactly what the combined patch will display.
///
/// `from` is treated as exclusive and `to` as inclusive (matches
/// `git diff <from> <to>`).
pub async fn range_diff_files(
    exec: &ShellExecutor,
    repo: &Path,
    from: &str,
    to: &str,
) -> GitResult<Vec<FileChange>> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "diff",
            "--no-color",
            "--name-status",
            from,
            to,
        ],
    )
    .await?;
    Ok(parse_name_status(&stdout))
}

/// Per-file unified diff for a range of commits (`git diff <from> <to>
/// -- <path>`). Mirrors [`commit_diff_file`] but for a range instead of
/// a single revision. Status is derived from the same `--name-status`
/// pass so the caller doesn't need to re-issue the listing.
pub async fn range_diff_file(
    exec: &ShellExecutor,
    repo: &Path,
    from: &str,
    to: &str,
    path: &str,
) -> GitResult<FileDiff> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "diff",
            "--no-color",
            from,
            to,
            "--",
            path,
        ],
    )
    .await?;
    let status_stdout = shell::git(
        exec,
        repo,
        &[
            "diff",
            "--no-color",
            "--name-status",
            from,
            to,
            "--",
            path,
        ],
    )
    .await
    .unwrap_or_default();
    let mut status = FileChangeStatus::M;
    let mut from_path: Option<String> = None;
    if let Some(line) = status_stdout.lines().next() {
        let mut parts = line.splitn(3, '\t');
        if let Some(letter) = parts.next() {
            if let Some(c) = letter.chars().next() {
                status = FileChangeStatus::from_letter(c);
            }
        }
        let p1 = parts.next();
        let p2 = parts.next();
        if let (Some(a), Some(_)) = (p1, p2) {
            from_path = Some(a.to_string());
        }
    }
    let binary = stdout.contains("Binary files ") && stdout.contains(" differ");
    Ok(FileDiff {
        path: path.to_string(),
        from_path,
        status,
        patch: stdout,
        binary,
    })
}

/// Read the contents of a file at a given revision (`git show <rev>:<path>`).
/// Returns an empty string when the path didn't exist at `rev` rather
/// than erroring — callers (e.g. the diff viewer) treat "missing" as
/// "added/deleted", and the calling layer already knows the `FileChangeStatus`.
pub async fn file_at_rev(
    exec: &ShellExecutor,
    repo: &Path,
    rev: &str,
    path: &str,
) -> GitResult<String> {
    let target = format!("{rev}:{path}");
    match shell::git(exec, repo, &["show", &target]).await {
        Ok(s) => Ok(s),
        Err(crate::error::GitError::Shell(zen_shell::ShellError::CommandFailed { .. })) => {
            Ok(String::new())
        }
        Err(e) => Err(e),
    }
}

fn parse_name_status(stdout: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let letter = parts.next().unwrap_or("");
        let p1 = parts.next();
        let p2 = parts.next();
        let Some(first) = letter.chars().next() else {
            continue;
        };
        let status = FileChangeStatus::from_letter(first);
        match (p1, p2) {
            (Some(a), Some(b)) => out.push(FileChange {
                status,
                path: b.to_string(),
                from_path: Some(a.to_string()),
            }),
            (Some(a), None) => out.push(FileChange {
                status,
                path: a.to_string(),
                from_path: None,
            }),
            _ => {}
        }
    }
    out
}
