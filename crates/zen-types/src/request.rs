//! HTTP request domain types: methods, dependency references, requests, files.

use ahash::HashMap;
use serde::{Deserialize, Serialize};
use std::fmt;

/// HTTP request method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    /// `GET`
    #[default]
    Get,
    /// `POST`
    Post,
    /// `PUT`
    Put,
    /// `DELETE`
    Delete,
    /// `PATCH`
    Patch,
    /// `HEAD`
    Head,
    /// `OPTIONS`
    Options,
}

impl fmt::Display for HttpMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl HttpMethod {
    /// Uppercase wire form of the method.
    pub const fn as_str(&self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Delete => "DELETE",
            HttpMethod::Patch => "PATCH",
            HttpMethod::Head => "HEAD",
            HttpMethod::Options => "OPTIONS",
        }
    }

    /// Parse a case-insensitive method string.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "GET" => Some(HttpMethod::Get),
            "POST" => Some(HttpMethod::Post),
            "PUT" => Some(HttpMethod::Put),
            "DELETE" => Some(HttpMethod::Delete),
            "PATCH" => Some(HttpMethod::Patch),
            "HEAD" => Some(HttpMethod::Head),
            "OPTIONS" => Some(HttpMethod::Options),
            _ => None,
        }
    }
}

/// A dependency reference declared in an `.http` file annotation.
///
/// `rename_all_fields` is required so the inner `file_path` /
/// `request_name` fields are camelCased on the wire — without it the
/// front-end's `{ kind: "crossFile"; filePath; requestName }` shape
/// would silently mismatch.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DependencyRef {
    /// Local dependency: request name in the same file.
    Local {
        /// Target request name.
        name: String,
    },
    /// Cross-file dependency: file path + request name.
    CrossFile {
        /// Relative path of the source file.
        file_path: String,
        /// Target request name.
        request_name: String,
    },
}

impl DependencyRef {
    /// Parse a dependency annotation value.
    ///
    /// * `"Login"` → [`DependencyRef::Local`]
    /// * `"auth.http:Login"` → [`DependencyRef::CrossFile`]
    pub fn parse(s: &str) -> Self {
        if let Some(pos) = s.rfind(':') {
            let file = &s[..pos];
            if file.ends_with(".http") || file.ends_with(".rest") {
                return DependencyRef::CrossFile {
                    file_path: file.to_string(),
                    request_name: s[pos + 1..].trim().to_string(),
                };
            }
        }
        DependencyRef::Local {
            name: s.trim().to_string(),
        }
    }

    /// The request-name part of the dependency.
    pub fn request_name(&self) -> &str {
        match self {
            DependencyRef::Local { name } => name,
            DependencyRef::CrossFile { request_name, .. } => request_name,
        }
    }

    /// `true` if this dependency points at another file.
    pub const fn is_cross_file(&self) -> bool {
        matches!(self, DependencyRef::CrossFile { .. })
    }

    /// Display string (`name` or `file:name`).
    pub fn display(&self) -> String {
        match self {
            DependencyRef::Local { name } => name.clone(),
            DependencyRef::CrossFile {
                file_path,
                request_name,
            } => format!("{file_path}:{request_name}"),
        }
    }
}

/// A parsed HTTP request from a `.http` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    /// Random UUID identifier (regenerated on every parse).
    pub id: String,
    /// `# @name` annotation value, if present.
    pub name: Option<String>,
    /// HTTP method.
    pub method: HttpMethod,
    /// URL with `{{variable}}` placeholders.
    pub url: String,
    /// Header map.
    pub headers: HashMap<String, String>,
    /// Request body (raw, with placeholders).
    pub body: Option<String>,
    /// `# @depends` references.
    pub depends_on: Vec<DependencyRef>,
    /// `# @extract var = path` map.
    pub extract: HashMap<String, String>,
    /// `# @assert ...` raw expressions.
    pub assertions: Vec<String>,
    /// 1-based line where this request begins in its source file.
    pub line_number: usize,
    /// Absolute path of the source file (skipped over the IPC boundary).
    #[serde(skip)]
    pub source_file: Option<String>,
}

impl Default for HttpRequest {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: None,
            method: HttpMethod::Get,
            url: String::new(),
            headers: HashMap::default(),
            body: None,
            depends_on: Vec::new(),
            extract: HashMap::default(),
            assertions: Vec::new(),
            line_number: 0,
            source_file: None,
        }
    }
}

impl HttpRequest {
    /// Stable identifier of the form `source_file:name` that survives
    /// re-parses. Falls back to the UUID when no name is present.
    pub fn stable_id(&self) -> String {
        let name = self.name.clone().unwrap_or_else(|| self.id.clone());
        match &self.source_file {
            Some(source) => format!("{source}:{name}"),
            None => name,
        }
    }

    /// Display name for UIs — falls back to a short slice of the UUID.
    pub fn display_name(&self) -> &str {
        self.name
            .as_deref()
            .unwrap_or(&self.id[..8.min(self.id.len())])
    }

    /// URL minus scheme + host (best-effort).
    pub fn short_url(&self) -> String {
        if let Some(start) = self.url.find("://") {
            if let Some(idx) = self.url[start + 3..].find('/') {
                return self.url[start + 3 + idx..].to_string();
            }
        }
        self.url.clone()
    }
}

/// A parsed `.http` file: the requests it declares plus its in-place
/// `@variable` map.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFile {
    /// Absolute path on disk.
    pub path: String,
    /// Filename (last path component).
    pub filename: String,
    /// Requests in declaration order.
    pub requests: Vec<HttpRequest>,
    /// `@var = value` declarations at the top of the file.
    pub local_variables: HashMap<String, String>,
}

impl HttpFile {
    /// Build a new (empty) file shell from an absolute path.
    pub fn new(path: String) -> Self {
        let filename = std::path::Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        Self {
            path,
            filename,
            requests: Vec::new(),
            local_variables: HashMap::default(),
        }
    }
}

/// File-tree item kind for the sidebar UIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileType {
    /// `.http` / `.rest` file.
    HttpFile,
    /// `http-client.env.json` (or variants).
    EnvFile,
    /// `*.perf.yaml`.
    PerfFile,
    /// `perf.variable*.yaml`.
    PerfVariableFile,
    /// Directory.
    Directory,
}

/// One entry in the sidebar file tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeItem {
    /// Display name (basename).
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// `true` for directories.
    pub is_dir: bool,
    /// Indentation depth from the discovery root.
    pub depth: usize,
    /// Whether the directory should render expanded (server-side hint).
    pub expanded: bool,
    /// File kind.
    pub file_type: FileType,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_dep() {
        assert_eq!(
            DependencyRef::parse("Login"),
            DependencyRef::Local {
                name: "Login".into()
            }
        );
    }

    #[test]
    fn parses_cross_file_dep() {
        assert_eq!(
            DependencyRef::parse("auth.http:Login"),
            DependencyRef::CrossFile {
                file_path: "auth.http".into(),
                request_name: "Login".into(),
            }
        );
    }

    #[test]
    fn parses_relative_cross_file() {
        assert_eq!(
            DependencyRef::parse("../common/auth.http:GetToken"),
            DependencyRef::CrossFile {
                file_path: "../common/auth.http".into(),
                request_name: "GetToken".into(),
            }
        );
    }

    #[test]
    fn ignores_colons_in_non_files() {
        assert_eq!(
            DependencyRef::parse("localhost:8080"),
            DependencyRef::Local {
                name: "localhost:8080".into()
            }
        );
    }

    #[test]
    fn http_method_parse_roundtrip() {
        for m in [
            HttpMethod::Get,
            HttpMethod::Post,
            HttpMethod::Put,
            HttpMethod::Delete,
            HttpMethod::Patch,
            HttpMethod::Head,
            HttpMethod::Options,
        ] {
            assert_eq!(HttpMethod::parse(m.as_str()), Some(m));
        }
        assert_eq!(HttpMethod::parse("get"), Some(HttpMethod::Get));
        assert_eq!(HttpMethod::parse("nope"), None);
    }

    #[test]
    fn short_url_strips_origin() {
        let mut r = HttpRequest::default();
        r.url = "https://api.example.com/v1/users?q=1".into();
        assert_eq!(r.short_url(), "/v1/users?q=1");
        r.url = "/health".into();
        assert_eq!(r.short_url(), "/health");
    }
}
