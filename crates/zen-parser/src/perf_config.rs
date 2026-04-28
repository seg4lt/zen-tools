//! Performance test configuration: structures and YAML loading.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zen_types::request::{FileTreeItem, FileType};

use crate::error::ParserError;
use crate::variables::{load_perf_variables_hierarchy, substitute_perf_variables};

/// Root configuration for performance tests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfConfig {
    /// Tests declared by the file.
    pub tests: Vec<PerfTest>,
}

/// A single performance test definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfTest {
    /// Display name of the test.
    pub name: String,
    /// Reference to a request: `"auth.http:Login"`.
    pub request: String,
    /// Test-type-specific configuration.
    #[serde(flatten)]
    pub test_type: TestType,
    /// Base path for resolving relative file references (set after load).
    #[serde(skip)]
    pub base_path: Option<PathBuf>,
}

/// Different shapes of perf tests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TestType {
    /// Single request baseline.
    Atomic,
    /// Fixed concurrent users for a duration.
    Concurrent {
        /// Number of concurrent users.
        users: u32,
        /// Total duration of the test.
        #[serde(with = "humantime_serde")]
        duration: Duration,
        /// Optional global rate limit (requests/sec).
        #[serde(default)]
        rps: Option<u32>,
    },
    /// Linear ramp-up of users.
    Stress {
        /// Starting concurrent user count.
        start_users: u32,
        /// Final concurrent user count.
        end_users: u32,
        /// Time to reach `end_users`.
        #[serde(with = "humantime_serde")]
        ramp_up: Duration,
        /// Total duration including ramp-up.
        #[serde(with = "humantime_serde")]
        duration: Duration,
        /// Optional global rate limit.
        #[serde(default)]
        rps: Option<u32>,
    },
    /// Sudden burst against a baseline.
    Spike {
        /// Baseline user count.
        base_users: u32,
        /// Peak user count during the spike.
        spike_users: u32,
        /// Duration of the spike.
        #[serde(with = "humantime_serde")]
        spike_duration: Duration,
        /// Total test duration.
        #[serde(with = "humantime_serde")]
        total_duration: Duration,
        /// Optional global rate limit.
        #[serde(default)]
        rps: Option<u32>,
    },
    /// Long-running steady load.
    Soak {
        /// Concurrent users.
        users: u32,
        /// Test duration.
        #[serde(with = "humantime_serde")]
        duration: Duration,
        /// Optional global rate limit.
        #[serde(default)]
        rps: Option<u32>,
    },
}

impl PerfTest {
    /// Maximum concurrent users for this test.
    pub fn max_users(&self) -> u32 {
        match &self.test_type {
            TestType::Atomic => 1,
            TestType::Concurrent { users, .. } => *users,
            TestType::Stress { end_users, .. } => *end_users,
            TestType::Spike { spike_users, .. } => *spike_users,
            TestType::Soak { users, .. } => *users,
        }
    }

    /// Total wall-clock duration.
    pub fn total_duration(&self) -> Duration {
        match &self.test_type {
            TestType::Atomic => Duration::from_secs(0),
            TestType::Concurrent { duration, .. } => *duration,
            TestType::Stress { duration, .. } => *duration,
            TestType::Spike { total_duration, .. } => *total_duration,
            TestType::Soak { duration, .. } => *duration,
        }
    }

    /// Optional target requests per second.
    pub fn target_rps(&self) -> Option<u32> {
        match &self.test_type {
            TestType::Atomic => None,
            TestType::Concurrent { rps, .. } => *rps,
            TestType::Stress { rps, .. } => *rps,
            TestType::Spike { rps, .. } => *rps,
            TestType::Soak { rps, .. } => *rps,
        }
    }
}

impl PerfConfig {
    /// Load a config from disk without variable substitution.
    pub fn load(path: &Path) -> Result<Self, ParserError> {
        let content = std::fs::read_to_string(path).map_err(|source| ParserError::Io {
            path: path.display().to_string(),
            source,
        })?;
        serde_yaml::from_str(&content).map_err(|source| ParserError::InvalidYaml {
            path: path.display().to_string(),
            source,
        })
    }

    /// Load a config and substitute `{{variables}}` from the
    /// `perf.variable.yaml` hierarchy first.
    pub fn load_with_variables(path: &Path) -> Result<Self, ParserError> {
        let content = std::fs::read_to_string(path).map_err(|source| ParserError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let variables = load_perf_variables_hierarchy(path.parent().unwrap_or(path));
        let substituted = substitute_perf_variables(&content, &variables);

        serde_yaml::from_str(&substituted).map_err(|source| ParserError::InvalidYaml {
            path: path.display().to_string(),
            source,
        })
    }

    /// Look upward through `dir` and its parents for `perf.yaml` / `perf.yml`.
    pub fn find_in_directory(dir: &Path) -> Option<PathBuf> {
        const CANDIDATES: &[&str] = &["perf.yaml", "perf.yml"];

        for name in CANDIDATES {
            let path = dir.join(name);
            if path.exists() {
                return Some(path);
            }
        }

        dir.parent().and_then(Self::find_in_directory)
    }

    /// Recursively discover all perf-related files under `dir`.
    pub fn find_all_recursive(dir: &Path) -> Vec<PathBuf> {
        let mut results = Vec::new();
        Self::collect_recursive(dir, &mut results);
        results
    }

    fn collect_recursive(dir: &Path, results: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            if path.is_file() && Self::is_perf_file(&name) {
                results.push(path);
            } else if path.is_dir() && !name.starts_with('.') && name != "target" {
                Self::collect_recursive(&path, results);
            }
        }
    }

    /// Match the canonical perf-file naming patterns.
    pub fn is_perf_file(name: &str) -> bool {
        name == "perf.yaml"
            || name == "perf.yml"
            || name.ends_with(".perf.yaml")
            || name.ends_with(".perf.yml")
            || name == "perf.variable.yaml"
            || name == "perf.variable.yml"
    }

    /// Match the perf-variable file pattern.
    pub fn is_perf_variable_file(name: &str) -> bool {
        name == "perf.variable.yaml" || name == "perf.variable.yml"
    }

    /// Load and merge every perf config under `dir`.
    pub fn load_all_recursive(dir: &Path) -> Option<Self> {
        let paths = Self::find_all_recursive(dir);
        if paths.is_empty() {
            return None;
        }

        let mut all = Vec::new();
        for path in paths {
            let Ok(config) = Self::load(&path) else {
                continue;
            };
            let base_path = path.parent().map(Path::to_path_buf);
            let prefix = path
                .parent()
                .and_then(|p| p.strip_prefix(dir).ok())
                .map(|p| p.to_string_lossy().to_string())
                .filter(|s| !s.is_empty());

            for mut test in config.tests {
                test.base_path = base_path.clone();
                if let Some(ref pre) = prefix {
                    test.name = format!("{pre}/{}", test.name);
                }
                all.push(test);
            }
        }

        (!all.is_empty()).then_some(Self { tests: all })
    }

    /// Build a [`FileTreeItem`] tree of perf files for the sidebar.
    pub fn discover_perf_file_tree(root: &Path) -> Vec<FileTreeItem> {
        use std::collections::HashSet;

        let mut paths = Self::find_all_recursive(root);
        paths.sort();

        let mut items = Vec::new();
        let mut added: HashSet<PathBuf> = HashSet::new();

        for path in paths {
            let rel = path.strip_prefix(root).unwrap_or(&path);

            let mut ancestors: Vec<_> = rel.ancestors().skip(1).collect();
            ancestors.reverse();

            for (depth, ancestor) in ancestors.iter().enumerate() {
                if ancestor.as_os_str().is_empty() {
                    continue;
                }
                let full = root.join(ancestor);
                if !added.contains(&full) {
                    let name = ancestor
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    items.push(FileTreeItem {
                        name,
                        path: full.to_string_lossy().to_string(),
                        is_dir: true,
                        depth,
                        expanded: true,
                        file_type: FileType::Directory,
                    });
                    added.insert(full);
                }
            }

            let depth = rel.components().count().saturating_sub(1);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let file_type = if Self::is_perf_variable_file(&name) {
                FileType::PerfVariableFile
            } else {
                FileType::PerfFile
            };
            items.push(FileTreeItem {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                depth,
                expanded: false,
                file_type,
            });
        }

        items
    }
}

/// Parse `"auth.http:Login"` → `("auth.http", "Login")`.
pub fn parse_request_ref(reference: &str) -> Option<(String, String)> {
    let pos = reference.rfind(':')?;
    let file = &reference[..pos];
    if file.ends_with(".http") || file.ends_with(".rest") {
        Some((file.to_string(), reference[pos + 1..].to_string()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_ref() {
        assert_eq!(
            parse_request_ref("auth.http:Login"),
            Some(("auth.http".into(), "Login".into()))
        );
        assert_eq!(
            parse_request_ref("folder/api.http:GetUsers"),
            Some(("folder/api.http".into(), "GetUsers".into()))
        );
        assert_eq!(parse_request_ref("invalid"), None);
    }

    #[test]
    fn parses_yaml() {
        let yaml = r#"
tests:
  - name: "Login Test"
    request: "auth.http:Login"
    type: concurrent
    users: 10
    duration: 30s
"#;
        let config: PerfConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.tests.len(), 1);
        assert_eq!(config.tests[0].name, "Login Test");
        assert_eq!(config.tests[0].max_users(), 10);
    }
}
