//! Environment definitions parsed from `http-client.env.json`-style files.

use ahash::HashMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One named environment with its variable map.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Environment {
    /// Environment name (e.g. "development").
    pub name: String,
    /// Variable map — JSON values for fidelity with the source file.
    #[serde(flatten)]
    pub variables: HashMap<String, serde_json::Value>,
}

impl Environment {
    /// Look up a variable as a string, performing the same lossy conversion
    /// the original parser used.
    pub fn get_string(&self, key: &str) -> Option<String> {
        self.variables.get(key).map(value_to_string)
    }

    /// Project the variable map into a flat string-string map for variable
    /// substitution.
    pub fn as_string_map(&self) -> HashMap<String, String> {
        self.variables
            .iter()
            .map(|(k, v)| (k.clone(), value_to_string(v)))
            .collect()
    }
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

/// All environments defined by a single env JSON file.
#[derive(Debug, Clone, Default)]
pub struct EnvironmentFile {
    /// Path on disk.
    pub path: PathBuf,
    /// `name -> Environment`.
    pub environments: HashMap<String, Environment>,
}

impl EnvironmentFile {
    /// Sorted list of environment names declared in the file.
    pub fn env_names(&self) -> Vec<String> {
        let mut names: Vec<_> = self.environments.keys().cloned().collect();
        names.sort();
        names
    }

    /// Look up by name.
    pub fn get(&self, name: &str) -> Option<&Environment> {
        self.environments.get(name)
    }

    /// Parse from a file path + raw JSON contents.
    pub fn from_json(path: PathBuf, content: &str) -> Result<Self, serde_json::Error> {
        let raw: HashMap<String, HashMap<String, serde_json::Value>> =
            serde_json::from_str(content)?;

        let environments = raw
            .into_iter()
            .map(|(name, variables)| (name.clone(), Environment { name, variables }))
            .collect();

        Ok(Self { path, environments })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_environment_json() {
        let content = r#"{
            "development": { "host": "http://localhost:3000", "user": "dev" },
            "production":  { "host": "https://api.example.com" }
        }"#;
        let env = EnvironmentFile::from_json(PathBuf::from("env.json"), content).unwrap();
        let names = env.env_names();
        assert_eq!(
            names,
            vec!["development".to_string(), "production".to_string()]
        );
        assert_eq!(
            env.get("development")
                .unwrap()
                .get_string("host")
                .as_deref(),
            Some("http://localhost:3000")
        );
    }
}
