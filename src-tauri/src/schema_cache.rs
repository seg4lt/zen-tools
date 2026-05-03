//! Tauri-side wrapper around [`zen_db::SchemaCache`].
//!
//! The cache implementation now lives in `zen-db` so any future tool
//! that needs a per-table column cache can reuse it. This module just
//! resolves the canonical on-disk location (`<app_data_dir>/schema_cache.db`)
//! and produces the `SchemaCache` handle that gets registered as Tauri
//! managed state.
//!
//! See **`docs/STORAGE.md`** for how the schema-cache DB and the
//! user-config DB divide responsibility.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// Re-export the storage primitive so callers in this crate can keep
/// `use crate::schema_cache::SchemaCache` working.
pub use zen_db::{now_ms, CachedTable, CachedTableMeta, SchemaCache, DEFAULT_TTL_MS};

/// Open (or create) the schema cache at the canonical location.
pub fn open(app: &AppHandle) -> AppResult<SchemaCache> {
    let path = cache_path(app)?;
    Ok(SchemaCache::open_at(path)?)
}

/// Resolve `app_data_dir()/schema_cache.db`, creating the parent dir.
fn cache_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("schema_cache.db"))
}
