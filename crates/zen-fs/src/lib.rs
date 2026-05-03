//! Filesystem helpers shared across the zen-tools workspace.
//!
//! Three different tools (HTTP runner, SQL workspace, Markdown vault)
//! used to ship their own near-identical recursive directory walkers,
//! each with the same "skip dotfiles / `target` / `node_modules`",
//! "directories first, then files alphabetically" rules. This crate
//! provides one configurable [`walk_tree`] that they all delegate to.
//!
//! The crate has no async / IO crate dependencies — only `std::fs` and a
//! tiny `chrono` use for the [`unique_sibling`] timestamp fallback.

#![warn(missing_docs)]

use std::path::{Path, PathBuf};

/// Default set of directory basenames the walker prunes by default.
/// These are the ones every consumer agreed they never want to traverse:
/// the build outputs (`target`, `dist`, `build`) and the JS dependency
/// blob (`node_modules`).  Hidden files (anything starting with `.`)
/// are pruned separately by [`WalkConfig::skip_hidden`].
pub const DEFAULT_PRUNED_DIRS: &[&str] = &["target", "node_modules", "dist", "build"];

/// One entry yielded by the [`walk_tree`] walker.
#[derive(Debug, Clone)]
pub struct WalkEntry {
    /// Absolute (or root-relative if the caller passed a relative root)
    /// path to the entry.
    pub path: PathBuf,
    /// File or directory basename.
    pub name: String,
    /// `true` for directories, `false` for files.
    pub is_dir: bool,
    /// Distance from the root the walk started at (root itself is `0`).
    pub depth: usize,
}

/// Knobs controlling [`walk_tree`].
pub struct WalkConfig<'a> {
    /// Directory basenames to prune. Defaults to [`DEFAULT_PRUNED_DIRS`].
    pub pruned_dirs: &'a [&'a str],
    /// Whether to skip entries whose basename starts with `.` (hidden
    /// dotfiles + `.git` etc.). Defaults to `true`.
    pub skip_hidden: bool,
    /// Predicate that decides whether a file should be emitted. Receives
    /// the lowercased basename for cheap extension checks. Files where
    /// this returns `false` are silently skipped (the walker still
    /// recurses into directories).
    pub include_file: &'a dyn Fn(&str) -> bool,
    /// Predicate that decides whether a directory should be emitted
    /// **and** descended into. Useful for pruning empty subtrees in
    /// trees that should only show folders containing relevant files.
    /// If this returns `false`, the directory is skipped entirely (not
    /// emitted, not recursed). Defaults to "always include".
    pub include_dir: &'a dyn Fn(&Path) -> bool,
}

impl<'a> Default for WalkConfig<'a> {
    fn default() -> Self {
        Self {
            pruned_dirs: DEFAULT_PRUNED_DIRS,
            skip_hidden: true,
            include_file: &|_name| true,
            include_dir: &|_path| true,
        }
    }
}

/// Recursively walk `root`, emitting one [`WalkEntry`] for each
/// directory and file accepted by `cfg`.
///
/// Sort order at every level: directories first, then files, with each
/// group ordered alphabetically by basename. This matches the order all
/// three previous bespoke walkers used and is what the various tool
/// sidebars expect.
///
/// Errors during a single subtree (e.g. permission denied) are silently
/// ignored — the walker continues with the rest of the tree. This
/// matches the previous behaviour: tool sidebars should never fail to
/// render because one folder is unreadable.
pub fn walk_tree(root: &Path, cfg: &WalkConfig<'_>) -> Vec<WalkEntry> {
    let mut out = Vec::new();
    walk_inner(root, cfg, 0, &mut out);
    out
}

fn walk_inner(dir: &Path, cfg: &WalkConfig<'_>, depth: usize, out: &mut Vec<WalkEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by(|a, b| {
        let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for entry in entries {
        let path = entry.path();
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };

        if cfg.skip_hidden && name.starts_with('.') {
            continue;
        }
        if cfg.pruned_dirs.iter().any(|d| *d == name) {
            continue;
        }

        if path.is_dir() {
            if !(cfg.include_dir)(&path) {
                continue;
            }
            out.push(WalkEntry {
                path: path.clone(),
                name: name.clone(),
                is_dir: true,
                depth,
            });
            walk_inner(&path, cfg, depth + 1, out);
        } else {
            let lower = name.to_ascii_lowercase();
            if (cfg.include_file)(&lower) {
                out.push(WalkEntry {
                    path,
                    name,
                    is_dir: false,
                    depth,
                });
            }
        }
    }
}

/// Returns `true` if `dir` (or any descendant) contains at least one
/// entry the predicate accepts. Used to decide whether to emit an
/// otherwise empty parent folder. Same pruning rules as [`walk_tree`].
pub fn dir_contains<F: Fn(&str) -> bool>(dir: &Path, predicate: F) -> bool {
    dir_contains_inner(dir, &predicate)
}

fn dir_contains_inner<F: Fn(&str) -> bool>(dir: &Path, predicate: &F) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name() {
                if predicate(&name.to_string_lossy().to_ascii_lowercase()) {
                    return true;
                }
            }
        } else if path.is_dir() {
            let name = match path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            if name.starts_with('.') || DEFAULT_PRUNED_DIRS.iter().any(|d| *d == name) {
                continue;
            }
            if dir_contains_inner(&path, predicate) {
                return true;
            }
        }
    }
    false
}

/// Find a sibling name in `parent` that doesn't yet exist by appending
/// ` 2`, ` 3`, … to the file stem. Falls back to a millisecond-timestamp
/// suffix after 9999 attempts.
///
/// Examples (assuming `parent` already contains `notes.md`):
/// - `unique_sibling(parent, "notes.md")` → `parent/notes 2.md`
/// - `unique_sibling(parent, "ideas")`    → `parent/ideas`
pub fn unique_sibling(parent: &Path, name: &str) -> PathBuf {
    let candidate = parent.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    for n in 2..=9999 {
        let c = parent.join(format!("{stem} {n}{ext}"));
        if !c.exists() {
            return c;
        }
    }
    // Astronomically unlikely fallback; better than panicking.
    parent.join(format!(
        "{stem}-{}{ext}",
        chrono::Utc::now().timestamp_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn walks_files_and_dirs_with_default_pruning() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("a.txt"), "").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("b.txt"), "").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap(); // pruned
        fs::write(root.join("node_modules").join("c.txt"), "").unwrap();
        fs::create_dir(root.join(".hidden")).unwrap(); // pruned
        fs::write(root.join(".hidden").join("d.txt"), "").unwrap();

        let entries = walk_tree(root, &WalkConfig::default());
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first, then files, alphabetical within each group.
        assert_eq!(names, vec!["sub", "b.txt", "a.txt"]);
    }

    #[test]
    fn include_file_filters_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("note.md"), "").unwrap();
        fs::write(root.join("readme.txt"), "").unwrap();
        let cfg = WalkConfig {
            include_file: &|n| n.ends_with(".md"),
            ..Default::default()
        };
        let entries = walk_tree(root, &cfg);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["note.md"]);
    }

    #[test]
    fn dir_contains_recursive_match() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("a")).unwrap();
        fs::create_dir(root.join("a").join("b")).unwrap();
        fs::write(root.join("a").join("b").join("note.md"), "").unwrap();
        assert!(dir_contains(root, |n| n.ends_with(".md")));
        assert!(!dir_contains(root, |n| n.ends_with(".sql")));
    }

    #[test]
    fn unique_sibling_disambiguates() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Empty parent → name returned unchanged.
        let p = unique_sibling(root, "notes.md");
        assert_eq!(p, root.join("notes.md"));
        // Existing file → " 2.md" appended.
        fs::write(&p, "").unwrap();
        let p2 = unique_sibling(root, "notes.md");
        assert_eq!(p2, root.join("notes 2.md"));
    }
}
