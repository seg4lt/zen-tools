//! One-shot migration of the on-disk app-data directory from the
//! pre-rename bundle identifier `com.zen-tools.app` to the new
//! `com.seg4lt.zen-tools`.
//!
//! Tauri derives `app_data_dir()` from the bundle identifier in
//! `tauri.conf.json`, so changing the identifier silently moves the
//! directory the app reads/writes from. Without a migration step,
//! every existing user's first launch on the new build looks like a
//! fresh install — PRMaster filters, dictation model preferences,
//! HTTP-runner project list, run history, schema cache, last-route
//! pointer, all of it would appear lost (it's actually still on disk
//! at the old path, just orphaned).
//!
//! Behaviour:
//!
//!   1. Resolve the NEW dir via `AppHandle::path().app_data_dir()`.
//!   2. Derive the OLD dir as `<parent>/com.zen-tools.app` (sibling
//!      of the new dir under `~/Library/Application Support` /
//!      `%APPDATA%` / `$XDG_DATA_HOME`).
//!   3. Skip if old dir doesn't exist (clean install — nothing to do).
//!   4. Skip if new dir already contains `user_config.db` (the
//!      authoritative settings store — its presence means the user
//!      has already run the new build and possibly diverged from the
//!      old state, so we DON'T want to clobber).
//!   5. Otherwise recursively copy old → new. Files that already
//!      exist in the new dir are preserved (defensive — Tauri may
//!      have auto-created empty placeholders).
//!
//! Old dir is **never deleted**. Users keep a manual rollback path,
//! and disk cost is bounded (we're talking MBs, not GBs — the heavy
//! Whisper model files are downloaded fresh on demand anyway, not
//! migrated).
//!
//! Safe to call on every boot — steps 3 and 4 are the idempotency
//! gates. After the first successful migration, step 4 short-circuits
//! every subsequent boot. (Explicit marker file would be slightly
//! more robust against e.g. `rm user_config.db` inside the new dir,
//! but the cost of a redundant copy in that pathological case is
//! negligible — the recursive-copy already preserves any newer files
//! the user wrote, so a re-run is non-destructive.)

use std::path::Path;
use tauri::{AppHandle, Manager, Wry};

const LEGACY_BUNDLE_ID: &str = "com.zen-tools.app";

/// Files in the new dir whose presence means "this build has been
/// run before, do not migrate". Order matters: the first match wins.
const SETTLED_MARKERS: &[&str] = &["user_config.db", "preferences.json"];

/// Run the migration. Idempotent. Logs progress at info / warn level
/// via `tracing` — caller (typically `setup()` in `lib.rs`) is
/// expected to have a tracing subscriber installed by this point.
pub fn migrate_legacy_app_data_dir(app: &AppHandle<Wry>) {
    let new_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(?e, "data-dir migration: resolve app_data_dir failed; skipping");
            return;
        }
    };

    let old_dir = match new_dir.parent() {
        Some(parent) => parent.join(LEGACY_BUNDLE_ID),
        None => {
            tracing::warn!(?new_dir, "data-dir migration: new dir has no parent; skipping");
            return;
        }
    };

    if old_dir == new_dir {
        // Identical paths — happens if someone runs an old build
        // with the new identifier set in tauri.conf.json, or if a
        // future bump renames things back. Either way: nothing to do.
        return;
    }

    if !old_dir.is_dir() {
        // Clean install or migration already finished and old dir
        // was manually cleaned up. Either way: nothing to do.
        return;
    }

    // Has the new dir already been populated by a previous run? If
    // so, leave it alone — anything we'd copy over might overwrite
    // newer state.
    for marker in SETTLED_MARKERS {
        if new_dir.join(marker).exists() {
            tracing::debug!(
                marker,
                ?new_dir,
                "data-dir migration: new dir already has settled marker; skipping",
            );
            return;
        }
    }

    if let Err(e) = std::fs::create_dir_all(&new_dir) {
        tracing::warn!(?e, ?new_dir, "data-dir migration: create_dir_all failed; skipping");
        return;
    }

    match copy_dir_recursive(&old_dir, &new_dir) {
        Ok(stats) => {
            tracing::info!(
                from = %old_dir.display(),
                to = %new_dir.display(),
                files = stats.files_copied,
                bytes = stats.bytes_copied,
                "migrated legacy app-data dir (com.zen-tools.app → com.seg4lt.zen-tools)",
            );
        }
        Err(e) => {
            tracing::warn!(
                ?e,
                from = %old_dir.display(),
                to = %new_dir.display(),
                "data-dir migration: copy_dir_recursive failed; partial migration may be on disk",
            );
        }
    }
}

#[derive(Default)]
struct CopyStats {
    files_copied: u64,
    bytes_copied: u64,
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<CopyStats> {
    let mut stats = CopyStats::default();
    copy_dir_inner(src, dst, &mut stats)?;
    Ok(stats)
}

fn copy_dir_inner(src: &Path, dst: &Path, stats: &mut CopyStats) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;

        if ft.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_dir_inner(&from, &to, stats)?;
        } else if ft.is_file() {
            // Preserve files the user has already created in the new
            // dir — copying would overwrite content the new build
            // wrote. (In practice the SETTLED_MARKERS check above
            // skips us out before we reach here for any populated
            // dir, but defensive belt-and-suspenders.)
            if to.exists() {
                continue;
            }
            let bytes = std::fs::copy(&from, &to)?;
            stats.files_copied += 1;
            stats.bytes_copied = stats.bytes_copied.saturating_add(bytes);
        }
        // Symlinks: skipped silently. None of our app-data paths use
        // them today; if a future feature does, add a handler here.
    }
    Ok(())
}
