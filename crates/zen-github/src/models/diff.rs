//! Per-file diff DTOs returned by `GhClient::pr_diff`.
//!
//! Two source paths feed the same shape:
//!
//!  * **Local git** — when the host has a clone mapped via
//!    `LocalRepoMapping`, we run `git diff base...head` against the
//!    locally fetched refs and split by `diff --git` headers.
//!  * **gh REST** — fallback for unmapped repos, hits
//!    `/repos/{owner}/{repo}/pulls/{n}/files` (paginated).
//!
//! The frontend renders the unified `patch` text via CodeMirror's
//! `@codemirror/merge` so callers don't need to pre-split hunks.

use serde::{Deserialize, Serialize};

/// Status of one file in a PR diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    /// New file in the PR.
    Added,
    /// Modified content.
    Modified,
    /// Deleted file.
    Removed,
    /// File was renamed (and possibly modified). `old_path` carries the
    /// previous location.
    Renamed,
    /// Mode change only.
    Changed,
    /// Copied from another file.
    Copied,
    /// Unchanged (rarely seen in PR diffs but the GitHub API does emit
    /// this for permission-only changes).
    Unchanged,
}

impl FileStatus {
    /// Parse the GitHub REST `status` string.
    pub fn from_gh(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "added" => Self::Added,
            "removed" | "deleted" => Self::Removed,
            "renamed" => Self::Renamed,
            "copied" => Self::Copied,
            "changed" => Self::Changed,
            "unchanged" => Self::Unchanged,
            _ => Self::Modified,
        }
    }
}

/// One file inside a PR's diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    /// Repo-relative path of the file (post-rename).
    pub path: String,
    /// Pre-rename path, if applicable.
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Status (added/modified/removed/renamed/…).
    pub status: FileStatus,
    /// Lines added.
    pub additions: u32,
    /// Lines removed.
    pub deletions: u32,
    /// The unified-diff body for this file (without the leading
    /// `diff --git` header). Empty when the file is binary or when the
    /// hunk count exceeded GitHub's per-file cap.
    pub patch: String,
    /// `true` when GitHub reported this as binary (no patch text).
    pub binary: bool,
}

/// Where the diff came from — exposed so the UI can show a hint
/// ("loaded from local clone" vs "loaded via GitHub API").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffSource {
    /// Read from a local clone via `git diff`.
    LocalGit,
    /// Read from `gh api .../pulls/{n}/files`.
    GhRest,
}

/// Bundle returned by `GhClient::pr_diff`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrDiff {
    /// The files (in the order GitHub / git emitted them).
    pub files: Vec<FileDiff>,
    /// SHA of the head commit the diff is against — needed when
    /// posting a review comment back so GitHub anchors it correctly.
    #[serde(rename = "headSha")]
    pub head_sha: Option<String>,
    /// Where the diff came from.
    pub source: DiffSource,
}

/// Side of a diff a comment is attached to (mirrors GitHub's
/// `side` query parameter on `POST /pulls/{n}/comments`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide {
    /// Old / pre-change side.
    Left,
    /// New / post-change side. Default for added or modified lines.
    Right,
}

impl DiffSide {
    /// Wire-format string for the `side=` REST field.
    pub fn as_wire(self) -> &'static str {
        match self {
            DiffSide::Left => "LEFT",
            DiffSide::Right => "RIGHT",
        }
    }
}

/// Split a multi-file unified diff (the kind `git diff` emits) into one
/// [`FileDiff`] per file. Returns the per-file unified body unchanged
/// (including its `diff --git` header line) so renderers that want the
/// raw `--- / +++` markers can still see them.
///
/// Recognises:
///   - `new file mode` → [`FileStatus::Added`]
///   - `deleted file mode` → [`FileStatus::Removed`]
///   - `rename from / rename to` → [`FileStatus::Renamed`]
///   - `Binary files ... differ` → `binary: true`
///   - default → [`FileStatus::Modified`]
///
/// Counts `+` / `-` lines that are not the `+++` / `---` headers.
pub fn split_git_diff(input: &str) -> Vec<FileDiff> {
    let mut out: Vec<FileDiff> = Vec::new();
    let mut current_start: Option<usize> = None;
    let bytes = input.as_bytes();
    let mut line_starts = vec![0usize];
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' && i + 1 < bytes.len() {
            line_starts.push(i + 1);
        }
    }
    for &start in &line_starts {
        let end = bytes[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|p| start + p)
            .unwrap_or(bytes.len());
        let line = &input[start..end];
        if line.starts_with("diff --git ") {
            if let Some(prev_start) = current_start.take() {
                let chunk = &input[prev_start..start];
                if let Some(fd) = parse_file_chunk(chunk) {
                    out.push(fd);
                }
            }
            current_start = Some(start);
        }
    }
    if let Some(prev_start) = current_start {
        let chunk = &input[prev_start..];
        if let Some(fd) = parse_file_chunk(chunk) {
            out.push(fd);
        }
    }
    out
}

fn parse_file_chunk(chunk: &str) -> Option<FileDiff> {
    let mut lines = chunk.lines();
    let header = lines.next()?;
    if !header.starts_with("diff --git ") {
        return None;
    }
    // `diff --git a/<oldpath> b/<newpath>`
    let rest = header.trim_start_matches("diff --git ").trim();
    let (a_part, b_part) = match split_diff_header_paths(rest) {
        Some(parts) => parts,
        None => return None,
    };
    let mut path = b_part.trim_start_matches("b/").to_string();
    let mut old_path: Option<String> = None;
    let mut status = FileStatus::Modified;
    let mut binary = false;

    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;

    let mut in_hunk = false;
    for line in chunk.lines().skip(1) {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if line.starts_with("new file mode") {
            status = FileStatus::Added;
        } else if line.starts_with("deleted file mode") {
            status = FileStatus::Removed;
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            status = FileStatus::Renamed;
            old_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            path = rest.to_string();
        } else if line.starts_with("Binary files ") && line.ends_with(" differ") {
            binary = true;
        } else if in_hunk {
            if line.starts_with("+++") || line.starts_with("---") {
                continue;
            }
            if let Some(c) = line.chars().next() {
                if c == '+' {
                    additions += 1;
                } else if c == '-' {
                    deletions += 1;
                }
            }
        }
    }

    if old_path.is_none() && a_part.starts_with("a/") {
        let derived = a_part.trim_start_matches("a/").to_string();
        if derived != path {
            old_path = Some(derived);
        }
    }

    Some(FileDiff {
        path,
        old_path,
        status,
        additions,
        deletions,
        patch: chunk.to_string(),
        binary,
    })
}

/// Split the `a/<path> b/<path>` portion of a `diff --git` header,
/// honouring quoted paths emitted by git when a path contains
/// whitespace or non-ASCII bytes (`"a/My File" "b/My File"`).
fn split_diff_header_paths(rest: &str) -> Option<(String, String)> {
    let bytes = rest.as_bytes();
    if bytes.first().copied() == Some(b'"') {
        // Quoted form. Find the matching closing quote, then the next quoted segment.
        let end_a = find_unescaped_quote(rest, 1)?;
        let a = unescape_git_quoted(&rest[1..end_a]);
        let after = rest[end_a + 1..].trim_start();
        if !after.starts_with('"') {
            return None;
        }
        let b_inner = &after[1..];
        let end_b = find_unescaped_quote(b_inner, 0)?;
        let b = unescape_git_quoted(&b_inner[..end_b]);
        return Some((a, b));
    }
    // Unquoted: split on the first ` b/` occurrence (paths starting with
    // `a/` and `b/` is the universal git convention here).
    let idx = rest.find(" b/")?;
    let a = rest[..idx].to_string();
    let b = rest[idx + 1..].to_string();
    Some((a, b))
}

fn find_unescaped_quote(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

fn unescape_git_quoted(s: &str) -> String {
    // Bare-bones unescape — git uses C-style escapes inside quoted paths.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"diff --git a/src/foo.rs b/src/foo.rs
index 1234567..89abcde 100644
--- a/src/foo.rs
+++ b/src/foo.rs
@@ -1,3 +1,4 @@
 fn foo() {
-    println!("old");
+    println!("new");
+    let _ = 1;
 }
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.bin b/old.bin
deleted file mode 100644
index abc1234..0000000
Binary files a/old.bin and /dev/null differ
diff --git a/from.txt b/to.txt
similarity index 100%
rename from from.txt
rename to to.txt
"#;

    #[test]
    fn split_handles_modify_add_delete_rename() {
        let files = split_git_diff(SAMPLE);
        assert_eq!(files.len(), 4);

        let foo = &files[0];
        assert_eq!(foo.path, "src/foo.rs");
        assert_eq!(foo.status, FileStatus::Modified);
        assert_eq!(foo.additions, 2);
        assert_eq!(foo.deletions, 1);

        let added = &files[1];
        assert_eq!(added.path, "new.txt");
        assert_eq!(added.status, FileStatus::Added);
        assert_eq!(added.additions, 2);

        let bin = &files[2];
        assert_eq!(bin.path, "old.bin");
        assert_eq!(bin.status, FileStatus::Removed);
        assert!(bin.binary);

        let renamed = &files[3];
        assert_eq!(renamed.path, "to.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("from.txt"));
        assert_eq!(renamed.status, FileStatus::Renamed);
    }

    #[test]
    fn empty_input_yields_empty() {
        assert!(split_git_diff("").is_empty());
        assert!(split_git_diff("not a diff at all").is_empty());
    }

    #[test]
    fn single_file_round_trip() {
        let single = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
        let files = split_git_diff(single);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "x");
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
    }
}
