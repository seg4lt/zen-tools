//! Serializable boundary types passed to the React front-end.
//!
//! Most domain types in `zen-types` already serialise cleanly. The DTOs in
//! this module exist for cases where the wire shape needs to differ from
//! the internal one (e.g. `EnvironmentFile` carries a `PathBuf`).

use serde::Serialize;
use std::path::Path;
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

/// One perf test in DTO form.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfTestDto {
    /// Display name.
    pub name: String,
    /// `"file.http:Name"` reference.
    pub request: String,
    /// Test-type-specific configuration.
    pub test_type: TestType,
    /// Maximum concurrent users.
    pub max_users: u32,
    /// Total duration in milliseconds.
    pub total_duration_ms: u64,
    /// Optional rate limit.
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
        Self {
            name: test.name.clone(),
            request: test.request.clone(),
            test_type: test.test_type.clone(),
            max_users: test.max_users(),
            total_duration_ms: test.total_duration().as_millis() as u64,
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
