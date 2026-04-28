//! Thread-safe cache of parsed `.http` files.
//!
//! Re-parses are avoided by storing each file behind an `Arc` so cheap
//! clones can be handed to dependency resolvers and execution tasks. The
//! cache itself uses a `parking_lot::RwLock` so concurrent reads (the hot
//! path during dependency resolution) don't block each other.

use crate::error::FileRegistryError;
use ahash::HashMap;
use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::trace;
use zen_parser::parse_http_file;
use zen_types::request::HttpFile;

/// Concurrency-safe cache of parsed `.http` files keyed by canonical path.
#[derive(Debug, Default)]
pub struct FileRegistry {
    inner: RwLock<HashMap<PathBuf, Arc<HttpFile>>>,
}

impl FileRegistry {
    /// New, empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve a path (relative or absolute) against `base_file`'s parent
    /// directory and canonicalise it.
    pub fn resolve_path(base_file: &Path, relative_path: &str) -> Result<PathBuf, FileRegistryError> {
        let base_dir = base_file
            .parent()
            .ok_or_else(|| FileRegistryError::InvalidPath(base_file.display().to_string()))?;
        let resolved = base_dir.join(relative_path);
        resolved
            .canonicalize()
            .map_err(|_| FileRegistryError::FileNotFound(resolved))
    }

    /// Get a cached `Arc<HttpFile>` for `path` or load it from disk.
    pub fn get_or_load(&self, path: &Path) -> Result<Arc<HttpFile>, FileRegistryError> {
        let canonical = path
            .canonicalize()
            .map_err(|_| FileRegistryError::FileNotFound(path.to_path_buf()))?;

        if let Some(file) = self.inner.read().get(&canonical).cloned() {
            return Ok(file);
        }

        let content = std::fs::read_to_string(&canonical).map_err(|source| {
            FileRegistryError::ReadError {
                path: canonical.clone(),
                source,
            }
        })?;

        let mut parsed = parse_http_file(&canonical.display().to_string(), &content);
        let source = canonical.display().to_string();
        for r in &mut parsed.requests {
            r.source_file = Some(source.clone());
        }

        let arc = Arc::new(parsed);
        self.inner.write().insert(canonical.clone(), arc.clone());
        trace!(path = %canonical.display(), "registry: cached new file");
        Ok(arc)
    }

    /// Get-or-load relative to a base file.
    pub fn get_or_load_relative(
        &self,
        base_file: &Path,
        relative_path: &str,
    ) -> Result<Arc<HttpFile>, FileRegistryError> {
        let resolved = Self::resolve_path(base_file, relative_path)?;
        self.get_or_load(&resolved)
    }

    /// Pre-populate the cache. Useful when the caller has already parsed
    /// a file (e.g. just opened by the user).
    pub fn insert(&self, path: PathBuf, mut file: HttpFile) {
        let canonical = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => return,
        };
        let source = canonical.display().to_string();
        for r in &mut file.requests {
            r.source_file = Some(source.clone());
        }
        self.inner.write().insert(canonical, Arc::new(file));
    }

    /// Drop a single entry — call after writing to disk so the next read
    /// re-parses the new contents.
    pub fn invalidate(&self, path: &Path) {
        if let Ok(canonical) = path.canonicalize() {
            self.inner.write().remove(&canonical);
        }
    }

    /// Drop every cached file.
    pub fn clear(&self) {
        self.inner.write().clear();
    }

    /// Cache hit check (for testing / introspection).
    pub fn is_cached(&self, path: &Path) -> bool {
        path.canonicalize()
            .ok()
            .is_some_and(|c| self.inner.read().contains_key(&c))
    }
}
