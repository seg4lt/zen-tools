//! Install identity for the TCC permissions auto-recovery flow.
//!
//! macOS keys TCC permissions by **bundle id + cdhash** for unsigned
//! apps. Every reinstall (or unsigned rebuild) changes the cdhash,
//! which leaves the previous TCC entry "stuck": the toggle in System
//! Settings is dead because the entry's cdhash no longer matches the
//! running binary, and `AXIsProcessTrustedWithOptions(prompt: true)` is
//! a no-op once an entry exists in any state — even a stale one. The
//! user is left with no path back to a re-prompt.
//!
//! This module persists a tiny record of "the last install on this
//! machine that we observed as TCC-trusted." The lifecycle code reads
//! it on `start` and uses it as the gate for the auto-`tccutil reset`
//! decision:
//!
//!   * **No prior record** — first ever launch / fresh install. Just
//!     prompt; no entry exists so the system dialog will fire.
//!
//!   * **Prior record matches current install** — same binary as last
//!     time we saw a grant, but now denied. That's a deliberate
//!     revocation; we leave it alone and surface a banner.
//!
//!   * **Prior record from a *different* install** — cdhash almost
//!     certainly changed. Auto-`tccutil reset` is the user's expected
//!     outcome; the alternative is a dead toggle they can't recover
//!     from without reading internal docs.
//!
//! The "install" identity is a `(version, exe_mtime_ms)` tuple. Version
//! catches the common upgrade path (pulled from `tauri.conf.json`).
//! Executable mtime catches dev rebuilds at the same version, and any
//! unsigned rebuild — unsigned implies a different cdhash, which
//! implies different bytes on disk, which implies a different mtime.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::user_config::UserConfig;

/// `KvStore` key under which we persist [`PersistedPermissions`].
/// Independent from the legacy `"preferences"` blob so PRMaster's
/// settings, dictation's models, etc. all stay isolated.
pub const KEY: &str = "dictation.permissions_install_id";

/// Snapshot of the running binary that's stable across the lifetime
/// of one install — i.e. equal across launches of the same `.app`
/// bundle, different across reinstalls / version bumps / unsigned
/// rebuilds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallId {
    /// `tauri.conf.json::version`, e.g. `"0.1.13"`. Catches the
    /// "user installed a new release" case.
    pub version: String,
    /// `mtime` of the bundle's main executable in milliseconds since
    /// Unix epoch. Catches:
    ///
    ///   * unsigned rebuilds at the same version (cdhash changes →
    ///     bytes change → mtime changes),
    ///   * `cargo tauri build --debug` swaps that don't bump the
    ///     version field,
    ///   * any path where the .app bundle is replaced atomically.
    ///
    /// `0` if we couldn't read the executable's metadata; treated as
    /// "unknown, don't compare equal to anything." See
    /// [`InstallId::is_known`].
    pub exe_mtime_ms: u64,
}

impl InstallId {
    /// True iff we successfully read the executable mtime. Used by the
    /// lifecycle code to bail out of the auto-reset path when the
    /// install fingerprint can't be compared (better to surface the
    /// banner than to spuriously reset on a bad reading).
    pub fn is_known(&self) -> bool {
        self.exe_mtime_ms != 0
    }
}

/// Persistent record of the last install we observed each TCC
/// permission as granted on. Stored as one JSON blob under [`KEY`];
/// missing fields mean "never observed granted on any install."
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedPermissions {
    /// `Some` if we've ever observed Accessibility=trusted; carries
    /// the install id that observation was made on.
    #[serde(default)]
    pub accessibility: Option<GrantRecord>,
    /// `Some` if we've ever observed Microphone=authorized; carries
    /// the install id that observation was made on.
    #[serde(default)]
    pub microphone: Option<GrantRecord>,
}

/// One observation of a permission being granted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantRecord {
    /// The install id at the time we saw the grant.
    pub install_id: InstallId,
    /// Wall-clock timestamp (ms since Unix epoch) of the observation.
    /// Diagnostic only — the lifecycle code's decisions are driven
    /// entirely by `install_id`. Useful for bug reports.
    pub observed_at_ms: u64,
}

/// Read the running app's [`InstallId`]. Cheap (one config field +
/// one filesystem `metadata()` call); safe to call on every
/// `lifecycle::start`. Errors are swallowed and surfaced as a `0`
/// mtime — the gating logic falls back to "treat as unknown, don't
/// auto-reset" rather than poking TCC on bad data.
pub fn current(app: &AppHandle) -> InstallId {
    let version = app.config().version.clone().unwrap_or_default();
    let exe_mtime_ms = read_exe_mtime_ms(app).unwrap_or(0);
    InstallId {
        version,
        exe_mtime_ms,
    }
}

fn read_exe_mtime_ms(app: &AppHandle) -> Option<u64> {
    let path = current_executable_path(app)?;
    let meta = std::fs::metadata(&path).ok()?;
    let mtime = meta.modified().ok()?;
    let ms = mtime.duration_since(UNIX_EPOCH).ok()?.as_millis();
    Some(ms.try_into().ok()?)
}

/// Resolve the path of the currently-running executable. Tauri does
/// not expose this directly, so we use [`std::env::current_exe`] —
/// for a `.app` bundle on macOS that resolves to
/// `Foo.app/Contents/MacOS/Foo`, exactly the cdhash-relevant binary.
fn current_executable_path(_app: &AppHandle) -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Read the persisted permissions record, or `None` if the key has
/// never been written. Wraps the `KvStore` JSON-deserialise call and
/// converts any decode error into `None` (forward-compat: an older
/// app bumped the schema, rather than crash on launch we'll just
/// re-record the next observed grant).
pub fn read(cfg: &UserConfig) -> AppResult<Option<PersistedPermissions>> {
    cfg.get::<PersistedPermissions>(KEY)
        .map_err(|e| AppError::Other(format!("install_id: read {KEY}: {e}")))
}

/// Record an observed Accessibility grant. Writes the merged blob
/// back to `UserConfig`, preserving any prior microphone record.
pub fn record_accessibility_grant(cfg: &UserConfig, install_id: InstallId) -> AppResult<()> {
    let mut current_record = read(cfg)?.unwrap_or_default();
    current_record.accessibility = Some(GrantRecord {
        install_id,
        observed_at_ms: now_ms(),
    });
    write(cfg, &current_record)
}

/// Record an observed Microphone grant. Mirrors
/// [`record_accessibility_grant`].
pub fn record_microphone_grant(cfg: &UserConfig, install_id: InstallId) -> AppResult<()> {
    let mut current_record = read(cfg)?.unwrap_or_default();
    current_record.microphone = Some(GrantRecord {
        install_id,
        observed_at_ms: now_ms(),
    });
    write(cfg, &current_record)
}

fn write(cfg: &UserConfig, record: &PersistedPermissions) -> AppResult<()> {
    cfg.set(KEY, record)
        .map_err(|e| AppError::Other(format!("install_id: write {KEY}: {e}")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| d.as_millis().try_into().ok())
        .unwrap_or(0)
}

/// Decision the lifecycle code makes after probing TCC. Encapsulated
/// here (instead of inlined in `lifecycle.rs`) so it can be tested
/// independently of the AppKit/AVFoundation calls — the matrix is
/// pure logic on `(currently_granted, current_install, prior_record)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoFixDecision {
    /// Permission already granted — record the observation, no
    /// further action.
    AlreadyGranted,
    /// No prior record. Trigger the system prompt; assume no stale
    /// entry exists so the prompt will fire.
    PromptFresh,
    /// Prior record's install id differs from the current binary's.
    /// Run `tccutil reset` for the relevant service, then trigger
    /// the prompt — the entry is now gone so the prompt will fire.
    ResetThenPrompt,
    /// Prior record's install id matches the current binary's, but
    /// permission is denied. The user revoked it deliberately;
    /// surface the banner but do NOT auto-reset.
    DeliberateDenial,
    /// We couldn't read the current install id (bad executable
    /// metadata). Surface the banner; do not auto-reset on bad data.
    Unknown,
}

/// Pure decision logic. Inputs:
///
///   * `granted` — current TCC reading (`AXIsProcessTrusted` for
///     accessibility, `AVAuthorizationStatus == authorized` for mic).
///   * `current` — the running binary's install id.
///   * `prior` — the persisted grant record for this service, if any.
///
/// Returns the [`AutoFixDecision`] the lifecycle should follow.
pub fn decide_autofix(
    granted: bool,
    current: &InstallId,
    prior: Option<&GrantRecord>,
) -> AutoFixDecision {
    if granted {
        return AutoFixDecision::AlreadyGranted;
    }
    if !current.is_known() {
        return AutoFixDecision::Unknown;
    }
    match prior {
        None => AutoFixDecision::PromptFresh,
        Some(p) if &p.install_id == current => AutoFixDecision::DeliberateDenial,
        Some(_) => AutoFixDecision::ResetThenPrompt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iid(v: &str, m: u64) -> InstallId {
        InstallId {
            version: v.to_string(),
            exe_mtime_ms: m,
        }
    }
    fn rec(install: InstallId) -> GrantRecord {
        GrantRecord {
            install_id: install,
            observed_at_ms: 0,
        }
    }

    #[test]
    fn already_granted_short_circuits() {
        let cur = iid("0.1.13", 1000);
        assert_eq!(
            decide_autofix(true, &cur, None),
            AutoFixDecision::AlreadyGranted
        );
        assert_eq!(
            decide_autofix(true, &cur, Some(&rec(cur.clone()))),
            AutoFixDecision::AlreadyGranted
        );
    }

    #[test]
    fn no_prior_record_prompts_fresh() {
        let cur = iid("0.1.13", 1000);
        assert_eq!(
            decide_autofix(false, &cur, None),
            AutoFixDecision::PromptFresh
        );
    }

    #[test]
    fn same_install_denial_is_deliberate() {
        let cur = iid("0.1.13", 1000);
        assert_eq!(
            decide_autofix(false, &cur, Some(&rec(cur.clone()))),
            AutoFixDecision::DeliberateDenial
        );
    }

    #[test]
    fn different_version_triggers_reset() {
        let cur = iid("0.1.14", 2000);
        let prior_install = iid("0.1.13", 1000);
        assert_eq!(
            decide_autofix(false, &cur, Some(&rec(prior_install))),
            AutoFixDecision::ResetThenPrompt
        );
    }

    #[test]
    fn same_version_different_mtime_triggers_reset() {
        let cur = iid("0.1.13", 2000);
        let prior_install = iid("0.1.13", 1000);
        assert_eq!(
            decide_autofix(false, &cur, Some(&rec(prior_install))),
            AutoFixDecision::ResetThenPrompt
        );
    }

    #[test]
    fn unknown_install_id_does_not_auto_reset() {
        let cur = iid("0.1.13", 0); // exe_mtime read failed
        let prior_install = iid("0.1.12", 1000);
        assert_eq!(
            decide_autofix(false, &cur, Some(&rec(prior_install))),
            AutoFixDecision::Unknown
        );
    }
}
