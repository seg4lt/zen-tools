//! Cleanup execution: dev-tool cache discovery, size estimation, and the
//! `git clean -fxd` / `rm -rf` runners.
//!
//! All filesystem work runs through `std::process::Command` (so behaviour
//! matches what a developer would type in their shell) and is driven in
//! parallel by rayon when bulk-running.

use rayon::prelude::*;
use serde::Deserialize;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// One locally installed Ollama model discovered from manifest files.
#[derive(Debug, Clone)]
pub struct OllamaModelTarget {
    /// Display label, e.g. `gemma4:31b`.
    pub label: String,
    /// Model ref accepted by `ollama rm`, e.g. `gemma4:31b`.
    pub model_ref: String,
    /// Absolute path to the manifest file on disk.
    pub manifest_path: PathBuf,
    /// Sum of manifest layer sizes when readable.
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OllamaManifest {
    #[serde(default)]
    config: Option<OllamaManifestBlob>,
    #[serde(default)]
    layers: Vec<OllamaManifestBlob>,
}

#[derive(Debug, Deserialize)]
struct OllamaManifestBlob {
    size: u64,
}

/// Which side-effect to apply to a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoCommandKind {
    /// `git clean -fxd` inside the repo (untracked + ignored files).
    Clean,
    /// `rm -rf` against the entire repo path.
    Delete,
}

impl RepoCommandKind {
    /// Lowercase short label (used inside command display strings).
    pub fn label(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Delete => "delete",
        }
    }
}

/// One discovered global dev-tool cache entry (npm cache, gradle caches, …).
#[derive(Debug, Clone)]
pub struct GlobalCleanupTarget {
    /// Human-readable label (e.g. "npm cache").
    pub label: String,
    /// Absolute path on disk.
    pub path: PathBuf,
    /// Whether `path` resolves to a directory (vs a single file).
    pub is_dir: bool,
    /// Total size in bytes when known.
    pub size: Option<u64>,
}

/// Reclaim estimate for a single repository.
#[derive(Debug, Clone)]
pub struct RepoSavingsEstimate {
    /// The repo this estimate refers to.
    pub repo_path: PathBuf,
    /// Bytes that `git clean -fxd` would reclaim, if measurable.
    pub clean_size: Option<u64>,
    /// Total bytes occupied by the repo on disk, if measurable.
    pub delete_size: Option<u64>,
}

/// Marked target ready for execution.
#[derive(Debug, Clone)]
pub enum RepoCommand {
    /// Apply `kind` to a git repo.
    Repo {
        /// Repository root.
        repo_path: PathBuf,
        /// Operation to perform.
        kind: RepoCommandKind,
    },
    /// `rm -rf` a global cache target.
    GlobalDelete {
        /// Display label, used in result messages.
        label: String,
        /// Path to delete.
        path: PathBuf,
    },
    /// Remove an Ollama model via `ollama rm`.
    OllamaDelete {
        /// Display label, used in result messages.
        label: String,
        /// Model ref accepted by `ollama rm`.
        model_ref: String,
    },
}

impl RepoCommand {
    /// `[clean] /path/to/repo` style display string.
    pub fn display_label(&self) -> String {
        match self {
            Self::Repo { repo_path, kind } => {
                format!("[{}] {}", kind.label(), repo_path.display())
            }
            Self::GlobalDelete { label, path } => {
                format!("[delete] {} ({})", label, path.display())
            }
            Self::OllamaDelete { label, model_ref } => {
                format!("[delete] {label} ({model_ref})")
            }
        }
    }
}

/// Run a single command. Returns the display label on success.
pub fn run_repo_command(command: &RepoCommand) -> Result<String, String> {
    let display = command.display_label();
    let result = match command {
        RepoCommand::Repo { repo_path, kind } => match kind {
            RepoCommandKind::Clean => clean_repo(repo_path),
            RepoCommandKind::Delete => delete_path(repo_path),
        },
        RepoCommand::GlobalDelete { path, .. } => delete_path(path),
        RepoCommand::OllamaDelete { model_ref, .. } => delete_ollama_model(model_ref),
    };

    result.map(|_| display)
}

/// Run a batch of commands in parallel. Returns `(succeeded, failed)`
/// where each failure is a `(display_label, error_message)` pair.
pub fn run_repo_commands(commands: Vec<RepoCommand>) -> (Vec<String>, Vec<(String, String)>) {
    let results: Vec<_> = commands
        .into_par_iter()
        .map(|command| {
            let label = command.display_label();
            match run_repo_command(&command) {
                Ok(done) => Ok(done),
                Err(e) => Err((label, e)),
            }
        })
        .collect();

    let mut succeeded = Vec::new();
    let mut failed = Vec::new();

    for result in results {
        match result {
            Ok(item) => succeeded.push(item),
            Err((item, error)) => failed.push((item, error)),
        }
    }

    (succeeded, failed)
}

fn clean_repo(repo_path: &PathBuf) -> Result<(), String> {
    let output = Command::new("git")
        .args(["clean", "-fxd"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git clean: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("git clean exited with status {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

fn delete_path(path: &PathBuf) -> Result<(), String> {
    let output = Command::new("rm")
        .arg("-rf")
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run rm -rf: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("rm -rf exited with status {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

/// Hard-coded list of macOS / Linux dev-tool cache locations. Filters
/// down to the entries that actually exist on the current system.
pub fn discover_global_cleanup_targets() -> Vec<GlobalCleanupTarget> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };

    let library = home.join("Library");

    let candidates = [
        ("SDKMAN installs/data", home.join(".sdkman")),
        ("Ivy cache", home.join(".ivy2/cache")),
        ("SBT data/cache", home.join(".sbt")),
        ("Coursier cache", home.join(".cache/coursier")),
        ("Coursier cache (macOS)", library.join("Caches/Coursier")),
        ("Maven local repository", home.join(".m2/repository")),
        ("Maven wrapper cache", home.join(".m2/wrapper")),
        ("Gradle caches", home.join(".gradle/caches")),
        ("Gradle wrapper cache", home.join(".gradle/wrapper")),
        ("Gradle daemon state", home.join(".gradle/daemon")),
        ("Rust cargo registry cache", home.join(".cargo/registry")),
        ("Rust cargo git cache", home.join(".cargo/git")),
        ("Rustup downloads cache", home.join(".rustup/downloads")),
        ("Rustup temp files", home.join(".rustup/tmp")),
        ("npm cache", home.join(".npm")),
        ("node-gyp cache", home.join(".cache/node-gyp")),
        ("npm cache (macOS)", library.join("Caches/npm")),
        ("node-gyp cache (macOS)", library.join("Caches/node-gyp")),
        ("pnpm store", home.join(".pnpm-store")),
        ("pnpm store (macOS)", library.join("pnpm/store")),
        ("pnpm cache (macOS)", library.join("Caches/pnpm")),
        ("Yarn cache", home.join(".yarn")),
        ("Yarn cache (macOS)", library.join("Caches/Yarn")),
        ("Mise installs/data", home.join(".local/share/mise")),
        ("Mise cache", home.join(".cache/mise")),
        ("Mise config", home.join(".config/mise")),
        ("Homebrew cache", library.join("Caches/Homebrew")),
        ("Ollama cache (macOS)", library.join("Caches/ollama")),
        ("Ollama cache (macOS app)", library.join("Caches/com.electron.ollama")),
    ];

    let mut targets: Vec<_> = candidates
        .into_iter()
        .filter_map(|(label, path)| {
            if !path.exists() {
                return None;
            }

            Some(GlobalCleanupTarget {
                label: label.to_string(),
                is_dir: path.is_dir(),
                size: None,
                path,
            })
        })
        .collect();

    targets.sort_by(|a, b| a.path.cmp(&b.path));
    targets
}

/// Resolve the Ollama models directory (`OLLAMA_MODELS` or `~/.ollama/models`).
pub fn ollama_models_dir() -> Option<PathBuf> {
    if let Ok(path) = env::var("OLLAMA_MODELS") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    env::var_os("HOME").map(|home| PathBuf::from(home).join(".ollama").join("models"))
}

/// Discover every installed Ollama model under the manifests directory.
pub fn discover_ollama_models() -> Vec<OllamaModelTarget> {
    let Some(models_dir) = ollama_models_dir() else {
        return Vec::new();
    };
    let manifests_root = models_dir.join("manifests");
    if !manifests_root.is_dir() {
        return Vec::new();
    }

    let mut models = Vec::new();
    collect_ollama_models(&manifests_root, &manifests_root, &mut models);
    models.sort_by(|a, b| a.label.cmp(&b.label));
    models
}

fn collect_ollama_models(
    manifests_root: &Path,
    dir: &Path,
    out: &mut Vec<OllamaModelTarget>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_ollama_models(manifests_root, &path, out);
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let Some(model_ref) = ollama_model_ref_from_manifest(manifests_root, &path) else {
            continue;
        };

        out.push(OllamaModelTarget {
            label: model_ref.clone(),
            model_ref,
            size: estimate_ollama_manifest_size(&path),
            manifest_path: path,
        });
    }
}

fn ollama_model_ref_from_manifest(manifests_root: &Path, manifest_path: &Path) -> Option<String> {
    let rel = manifest_path.strip_prefix(manifests_root).ok()?;
    let mut parts: Vec<String> = rel
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();

    if parts.len() < 2 {
        return None;
    }

    let tag = parts.pop()?;
    let model = parts.pop()?;

    if parts.last().is_some_and(|part| part == "library") {
        parts.pop();
        parts.pop(); // registry host
        return Some(format!("{model}:{tag}"));
    }

    if !parts.is_empty() {
        parts.pop(); // registry host
    }

    let namespace = parts.join("/");
    if namespace.is_empty() {
        Some(format!("{model}:{tag}"))
    } else {
        Some(format!("{namespace}/{model}:{tag}"))
    }
}

fn estimate_ollama_manifest_size(manifest_path: &Path) -> Option<u64> {
    let raw = fs::read_to_string(manifest_path).ok()?;
    let manifest: OllamaManifest = serde_json::from_str(&raw).ok()?;
    let mut total = manifest.config.map(|blob| blob.size).unwrap_or(0);
    for layer in manifest.layers {
        total = total.saturating_add(layer.size);
    }
    Some(total)
}

fn delete_ollama_model(model_ref: &str) -> Result<(), String> {
    let output = Command::new("ollama")
        .arg("rm")
        .arg(model_ref)
        .output()
        .map_err(|e| format!("Failed to run ollama rm: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("ollama rm exited with status {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

/// Recursively sum the size of `path`. Returns `None` if the path can't
/// even be stat'd at the root.
pub fn estimate_path_size(path: &Path) -> Option<u64> {
    path_size_lossy(path)
}

/// Estimate the total + cleanable bytes for a single repository.
pub fn estimate_repo_savings(repo_path: &Path) -> RepoSavingsEstimate {
    RepoSavingsEstimate {
        repo_path: repo_path.to_path_buf(),
        delete_size: estimate_path_size(repo_path),
        clean_size: estimate_cleanable_size(repo_path),
    }
}

fn estimate_cleanable_size(repo_path: &Path) -> Option<u64> {
    let output = Command::new("git")
        .args(["clean", "-fxnd"])
        .current_dir(repo_path)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let rel_paths = parse_git_clean_dry_run(&stdout);
    let mut abs_paths: Vec<PathBuf> = rel_paths
        .into_iter()
        .map(|rel| repo_path.join(rel))
        .filter(|path| path.exists())
        .collect();

    prune_nested_paths(&mut abs_paths);

    let mut total = 0_u64;
    for path in abs_paths {
        if let Some(size) = estimate_path_size(&path) {
            total = total.saturating_add(size);
        }
    }

    Some(total)
}

fn parse_git_clean_dry_run(output: &str) -> Vec<PathBuf> {
    const PREFIX: &str = "Would remove ";

    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let rel = trimmed.strip_prefix(PREFIX)?.trim();
            if rel.is_empty() {
                return None;
            }
            Some(PathBuf::from(rel))
        })
        .collect()
}

fn prune_nested_paths(paths: &mut Vec<PathBuf>) {
    paths.sort_by(|a, b| {
        path_depth(a)
            .cmp(&path_depth(b))
            .then_with(|| path_sort_key(a).cmp(&path_sort_key(b)))
    });
    paths.dedup();

    let mut kept: Vec<PathBuf> = Vec::with_capacity(paths.len());
    'outer: for path in paths.drain(..) {
        for existing in &kept {
            if path.starts_with(existing) {
                continue 'outer;
            }
        }
        kept.push(path);
    }
    *paths = kept;
}

fn path_depth(path: &Path) -> usize {
    path.components().count()
}

fn path_sort_key(path: &Path) -> OsString {
    path.as_os_str().to_os_string()
}

fn path_size_lossy(path: &Path) -> Option<u64> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() || metadata.is_file() {
        return Some(metadata.len());
    }

    if metadata.is_dir() {
        let mut total = 0_u64;
        let entries = fs::read_dir(path).ok()?;
        for entry in entries.flatten() {
            if let Some(child_size) = path_size_lossy(&entry.path()) {
                total = total.saturating_add(child_size);
            }
        }
        return Some(total);
    }

    Some(metadata.len())
}
