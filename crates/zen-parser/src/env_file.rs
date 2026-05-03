//! Parsing and discovery for `http-client.env.json` style files.

use crate::error::ParserError;
use std::path::{Path, PathBuf};
use zen_types::environment::EnvironmentFile;

/// Parse an env JSON file's contents into an [`EnvironmentFile`].
pub fn parse_env_file(path: PathBuf, content: &str) -> Result<EnvironmentFile, ParserError> {
    EnvironmentFile::from_json(path.clone(), content).map_err(|source| ParserError::InvalidJson {
        path: path.display().to_string(),
        source,
    })
}

/// Pick a sensible default environment name from the available list.
/// Preference order: `development` → `dev` → first item.
///
/// This is the canonical "what env should we pick when the user hasn't
/// chosen one" rule, used by both the project loader (working with an
/// [`EnvironmentFile`]) and the file-open command (working with a flat
/// list of names).
pub fn pick_default_env_name<I, S>(names: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let names: Vec<String> = names.into_iter().map(|s| s.as_ref().to_string()).collect();
    if names.iter().any(|n| n == "development") {
        return Some("development".to_string());
    }
    if names.iter().any(|n| n == "dev") {
        return Some("dev".to_string());
    }
    names.into_iter().next()
}

/// Convenience wrapper: pick the default env from an
/// already-parsed [`EnvironmentFile`].
pub fn pick_default_env(env: &EnvironmentFile) -> Option<String> {
    pick_default_env_name(env.env_names())
}

/// Walk the directory tree (`directory` and all its parents) looking for an
/// env file in the canonical priority order.
pub fn find_env_file(directory: &Path) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "http-client.env.json",
        "http-client.private.env.json",
        ".env.json",
    ];

    for candidate in CANDIDATES {
        let path = directory.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }

    directory.parent().and_then(find_env_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_json() {
        let content = r#"{
            "development": { "host": "localhost:8080", "token": "dev" },
            "production":  { "host": "api.example.com",  "token": "prod" }
        }"#;
        let env = parse_env_file(PathBuf::from("env.json"), content).unwrap();
        assert_eq!(env.env_names(), vec!["development", "production"]);
        assert_eq!(
            env.get("development").unwrap().get_string("host"),
            Some("localhost:8080".into())
        );
    }
}
