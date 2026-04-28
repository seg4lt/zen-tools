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
