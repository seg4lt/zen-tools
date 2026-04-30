//! Parallel git-repository discovery.
//!
//! [`find_git_repos`] walks `folder` with rayon, recording every directory
//! that contains a `.git` entry. Once a repo is found we **stop** descending
//! into its working tree — we only follow declared submodule paths from
//! `.gitmodules`. That avoids walking `node_modules` / `target` etc. that
//! sit inside an already-discovered repo.

use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Find all git repository roots within the given folder, sorted.
pub fn find_git_repos(folder: &Path) -> Vec<PathBuf> {
    let repos = Mutex::new(Vec::new());
    find_git_repos_streaming(folder, |p| {
        repos.lock().unwrap().push(p.to_path_buf());
    });
    let mut repos = repos.into_inner().unwrap();
    repos.sort();
    repos
}

/// Streaming variant of [`find_git_repos`] — calls `on_repo` once for
/// every discovered repo root **as it is found**, in parallel.
///
/// Use this when the caller wants to render progress while the walk is
/// still in flight (e.g. emit Tauri events).  `on_repo` is invoked from
/// arbitrary rayon worker threads and must be `Send + Sync`; ordering
/// is non-deterministic.
pub fn find_git_repos_streaming<F>(folder: &Path, on_repo: F)
where
    F: Fn(&Path) + Sync + Send,
{
    walk(folder, &on_repo);
}

fn walk<F>(folder: &Path, on_repo: &F)
where
    F: Fn(&Path) + Sync + Send,
{
    // Check if current folder is a git repo
    let git_dir = folder.join(".git");
    if git_dir.exists() {
        on_repo(folder);

        // Optimization: once we're inside a repo, only recurse into declared submodules.
        // This avoids scanning the entire repo tree while still discovering nested git repos
        // that are intentionally part of the repository.
        let submodule_dirs = find_submodule_dirs(folder);
        submodule_dirs.par_iter().for_each(|submodule_dir| {
            walk(submodule_dir, on_repo);
        });
        return;
    }

    // Read directory entries
    let entries: Vec<_> = match std::fs::read_dir(folder) {
        Ok(entries) => entries.flatten().collect(),
        Err(_) => return,
    };

    // Process subdirectories in parallel
    entries
        .par_iter()
        .filter(|entry| entry.path().is_dir())
        .for_each(|entry| {
            let path = entry.path();

            // Skip hidden directories (including .git internals)
            if let Some(name) = path.file_name() {
                if let Some(name_str) = name.to_str() {
                    if name_str.starts_with('.') {
                        return;
                    }
                }
            }

            walk(&path, on_repo);
        });
}

fn find_submodule_dirs(repo_root: &Path) -> Vec<PathBuf> {
    let gitmodules = repo_root.join(".gitmodules");
    let contents = match std::fs::read_to_string(&gitmodules) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(),
    };

    contents
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (key, value) = trimmed.split_once('=')?;
            if key.trim() != "path" {
                return None;
            }

            let submodule_path = value.trim();
            if submodule_path.is_empty() {
                return None;
            }

            let path = repo_root.join(submodule_path);
            if path.is_dir() {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}
