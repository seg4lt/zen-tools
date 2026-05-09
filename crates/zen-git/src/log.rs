//! Commit log queries — the engine surface for the IntelliJ-style log
//! viewer. Output is a custom delimiter-separated record stream so we
//! never need to JSON-quote commit-message bodies.

use std::path::Path;

use zen_shell::ShellExecutor;

use crate::error::{GitError, GitResult};
use crate::models::commit::{BranchRef, Commit};
use crate::models::filter::{CommitLogFilter, TextScope};
use crate::shell;

/// US (unit-separator) byte between fields inside one record.
const FS: char = '\x1f';
/// RS (record-separator) byte between commits.
const RS: char = '\x1e';

const PRETTY: &str = concat!(
    "--pretty=format:%H\x1f%P\x1f%an\x1f%ae\x1f%at\x1f%cn\x1f%ce\x1f%ct\x1f%s\x1f%b\x1e"
);

/// Execute `git log` with [`CommitLogFilter`] applied and decode the
/// resulting custom-format stream into [`Commit`]s.
pub async fn list_commits(
    exec: &ShellExecutor,
    repo: &Path,
    filter: &CommitLogFilter,
) -> GitResult<Vec<Commit>> {
    let mut args: Vec<String> = vec!["log".into(), PRETTY.into()];
    args.push("--no-color".into());
    args.push(format!("--skip={}", filter.skip));
    args.push(format!("--max-count={}", filter.limit.max(1)));

    if let Some(a) = &filter.author {
        args.push(format!("--author={a}"));
    }
    if let Some(s) = &filter.since {
        args.push(format!("--since={s}"));
    }
    if let Some(u) = &filter.until {
        args.push(format!("--until={u}"));
    }
    if filter.merges_only {
        args.push("--merges".into());
    }
    if filter.no_merges {
        args.push("--no-merges".into());
    }
    if let Some(text) = &filter.text {
        if !text.is_empty() {
            apply_text_search(&mut args, text);
        }
    }

    if let Some(branch) = filter
        .branch
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        args.push(branch);
    }

    if let Some(path) = filter
        .path
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        args.push("--".into());
        args.push(path);
    }

    let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let stdout = shell::git(exec, repo, &argv).await?;

    let mut commits = decode_log(&stdout)?;

    // Hash-prefix is git-side unsupported except via `--grep`, which
    // would mistakenly match the prefix in commit messages. Filter
    // client-side after the fact.
    if let Some(prefix) = filter
        .hash_prefix
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    {
        commits.retain(|c| c.hash.to_lowercase().starts_with(&prefix));
    }

    // Stitch in branch / tag refs pointing to each commit. Cheap once
    // per call: `git for-each-ref --format=%(objectname) %(refname:short)`.
    let refs_by_sha = list_refs_by_sha(exec, repo).await.unwrap_or_default();
    for c in &mut commits {
        if let Some(rs) = refs_by_sha.get(&c.hash) {
            c.refs = rs.clone();
        }
    }

    Ok(commits)
}

/// `git rev-list --count` for the same filter — used by the UI to show
/// "N matching commits" / drive infinite scroll. Skips `--skip` /
/// `--max-count` so the count is the *full* match set.
pub async fn count_commits(
    exec: &ShellExecutor,
    repo: &Path,
    filter: &CommitLogFilter,
) -> GitResult<u32> {
    let mut args: Vec<String> = vec!["rev-list".into(), "--count".into()];

    if let Some(a) = &filter.author {
        args.push(format!("--author={a}"));
    }
    if let Some(s) = &filter.since {
        args.push(format!("--since={s}"));
    }
    if let Some(u) = &filter.until {
        args.push(format!("--until={u}"));
    }
    if filter.merges_only {
        args.push("--merges".into());
    }
    if filter.no_merges {
        args.push("--no-merges".into());
    }
    if let Some(text) = &filter.text {
        if !text.is_empty() {
            apply_text_search(&mut args, text);
        }
    }

    let branch = filter
        .branch
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "HEAD".into());
    args.push(branch);

    if let Some(path) = filter
        .path
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        args.push("--".into());
        args.push(path);
    }

    let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let stdout = shell::git(exec, repo, &argv).await?;
    Ok(stdout.trim().parse::<u32>().unwrap_or(0))
}

/// Top-N distinct authors (display "Name <email>"), used to populate
/// the author-filter dropdown.
pub async fn list_authors(
    exec: &ShellExecutor,
    repo: &Path,
    limit: u32,
) -> GitResult<Vec<String>> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "log",
            "--all",
            "--pretty=format:%an <%ae>",
            "--no-color",
            &format!("--max-count={}", limit.max(1).min(2000)),
        ],
    )
    .await?;
    let mut seen = std::collections::BTreeSet::<String>::new();
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if seen.insert(line.to_string()) {
            out.push(line.to_string());
        }
    }
    Ok(out)
}

/// All branch refs (local + remote) with their tip SHA.
pub async fn list_branches(exec: &ShellExecutor, repo: &Path) -> GitResult<Vec<BranchRef>> {
    let head = shell::git_trimmed(exec, repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .unwrap_or_default();
    let stdout = shell::git(
        exec,
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)\x1f%(refname:short)\x1f%(objectname)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )
    .await?;
    let mut out = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split(FS).collect();
        if parts.len() != 3 {
            continue;
        }
        let full = parts[0].to_string();
        let short = parts[1].to_string();
        let tip = parts[2].to_string();
        let is_remote = full.starts_with("refs/remotes/");
        // Skip `refs/remotes/<remote>/HEAD` symbolic refs.
        if is_remote && short.ends_with("/HEAD") {
            continue;
        }
        let is_head = !is_remote && short == head;
        out.push(BranchRef {
            name: short,
            full_name: full,
            is_head,
            is_remote,
            tip,
        });
    }
    Ok(out)
}

fn apply_text_search(args: &mut Vec<String>, text: &crate::models::filter::TextSearch) {
    let q = text.query.clone();
    match text.scope {
        TextScope::Message => {
            args.push(format!("--grep={q}"));
            if !text.case_sensitive {
                args.push("-i".into());
            }
            if text.regex {
                args.push("-E".into());
            } else {
                args.push("--fixed-strings".into());
            }
        }
        TextScope::Changes => {
            // `-S` is always literal substring.
            args.push(format!("-S{q}"));
            if !text.case_sensitive {
                // git supports --regexp-ignore-case with -S/-G.
                args.push("--regexp-ignore-case".into());
            }
        }
        TextScope::ChangesRegex => {
            args.push(format!("-G{q}"));
            if !text.case_sensitive {
                args.push("--regexp-ignore-case".into());
            }
        }
    }
}

async fn list_refs_by_sha(
    exec: &ShellExecutor,
    repo: &Path,
) -> GitResult<std::collections::HashMap<String, Vec<String>>> {
    let stdout = shell::git(
        exec,
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname)\x1f%(refname:short)",
            "refs/heads/",
            "refs/remotes/",
            "refs/tags/",
        ],
    )
    .await?;
    let mut map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for line in stdout.lines() {
        let mut it = line.splitn(2, FS);
        let (Some(sha), Some(name)) = (it.next(), it.next()) else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        map.entry(sha.to_string()).or_default().push(name.to_string());
    }
    Ok(map)
}

fn decode_log(stdout: &str) -> GitResult<Vec<Commit>> {
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for record in stdout.split(RS) {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.splitn(10, FS).collect();
        if fields.len() < 10 {
            return Err(GitError::Parse(format!(
                "log record had {} fields, expected 10",
                fields.len()
            )));
        }
        let hash = fields[0].to_string();
        let parents: Vec<String> = if fields[1].trim().is_empty() {
            Vec::new()
        } else {
            fields[1].split_whitespace().map(|s| s.to_string()).collect()
        };
        let author_ts: i64 = fields[4].trim().parse().unwrap_or(0);
        let committer_ts: i64 = fields[7].trim().parse().unwrap_or(0);
        let short_hash = hash.chars().take(7).collect();
        out.push(Commit {
            hash,
            short_hash,
            parents,
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            author_ts,
            committer_name: fields[5].to_string(),
            committer_email: fields[6].to_string(),
            committer_ts,
            subject: fields[8].to_string(),
            body: fields[9].trim_end_matches('\n').to_string(),
            refs: Vec::new(),
        });
    }
    Ok(out)
}
