//! Serializable boundary types passed to the React front-end.
//!
//! Most domain types in `zen-types` already serialise cleanly. The DTOs in
//! this module exist for cases where the wire shape needs to differ from
//! the internal one (e.g. `EnvironmentFile` carries a `PathBuf`).

use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use zen_parser::{PerfConfig, PerfTest, TestType};
use zen_types::prelude::*;

/// `EnvironmentFile` minus its `PathBuf` (the front-end never inspects it).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentFileDto {
    /// File path on disk.
    pub path: String,
    /// Environment names declared in the file.
    pub names: Vec<String>,
}

impl From<&EnvironmentFile> for EnvironmentFileDto {
    fn from(env: &EnvironmentFile) -> Self {
        Self {
            path: env.path.display().to_string(),
            names: env.env_names(),
        }
    }
}

/// Project a [`PerfConfig`] into a serialisable form. The internal struct
/// is already serialisable but `PerfTest::base_path` (PathBuf) is skipped
/// in `serde`, so this DTO also surfaces the source path as a string for
/// UI reference.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfConfigDto {
    /// Source file path on disk.
    pub path: String,
    /// Tests in declaration order.
    pub tests: Vec<PerfTestDto>,
}

/// Variant tag of a [`TestType`] in IPC-friendly form.
///
/// `TestType` itself is shaped for **YAML parsing** (snake_case fields,
/// the same struct serves both directions), so we cannot blindly slap
/// `rename_all_fields = "camelCase"` on it without breaking on-disk
/// configs. The frontend only needs the discriminator + the already-
/// flattened `maxUsers`/`totalDurationMs`/`targetRps` summary fields,
/// so this DTO carries just the tag.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTypeDto {
    /// `"atomic" | "concurrent" | "stress" | "spike" | "soak"`.
    #[serde(rename = "type")]
    pub kind: &'static str,
}

impl TestTypeDto {
    fn from_test_type(t: &TestType) -> Self {
        let kind = match t {
            TestType::Atomic => "atomic",
            TestType::Concurrent { .. } => "concurrent",
            TestType::Stress { .. } => "stress",
            TestType::Spike { .. } => "spike",
            TestType::Soak { .. } => "soak",
        };
        Self { kind }
    }
}

/// One perf test in DTO form.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfTestDto {
    /// Display name.
    pub name: String,
    /// `"file.http:Name"` reference.
    pub request: String,
    /// Test type discriminator (atomic / concurrent / stress / spike / soak).
    pub test_type: TestTypeDto,
    /// Maximum concurrent users.
    pub max_users: u32,
    /// Total duration in milliseconds.
    pub total_duration_ms: u64,
    /// Ramp-up duration in milliseconds (0 for tests without ramp-up).
    pub ramp_up_ms: u64,
    /// Optional rate limit (req/s); `null` when unspecified.
    pub target_rps: Option<u32>,
}

impl PerfConfigDto {
    /// Build a DTO from a config + the path it was loaded from.
    pub fn from_config(config: &PerfConfig, path: &Path) -> Self {
        Self {
            path: path.display().to_string(),
            tests: config.tests.iter().map(PerfTestDto::from_test).collect(),
        }
    }
}

impl PerfTestDto {
    fn from_test(test: &PerfTest) -> Self {
        let ramp_up = match &test.test_type {
            TestType::Stress { ramp_up, .. } => *ramp_up,
            _ => Duration::ZERO,
        };
        Self {
            name: test.name.clone(),
            request: test.request.clone(),
            test_type: TestTypeDto::from_test_type(&test.test_type),
            max_users: test.max_users(),
            total_duration_ms: test.total_duration().as_millis() as u64,
            ramp_up_ms: ramp_up.as_millis() as u64,
            target_rps: test.target_rps(),
        }
    }
}

/// Wrapper around HttpFile for opening — adds the `EnvironmentFileDto`
/// resolved alongside it (so the UI can show the env selector immediately).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedHttpFileDto {
    /// Parsed file.
    pub file: HttpFile,
    /// Local env file resolved from the file's directory, if any.
    pub local_env: Option<EnvironmentFileDto>,
}
