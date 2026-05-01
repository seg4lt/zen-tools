//! Application error type that unifies the workspace crates and serialises
//! cleanly to the front-end.

use serde::{Serialize, Serializer};
use thiserror::Error;
use zen_db::DbError;
use zen_http::{CrossFileDependencyError, DependencyError, FileRegistryError, HttpError};
use zen_parser::ParserError;
use zen_perf::PerfError;

/// All errors raised by Tauri commands.
#[derive(Debug, Error)]
pub enum AppError {
    /// Filesystem I/O error.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Parser failure.
    #[error("parser: {0}")]
    Parser(#[from] ParserError),

    /// HTTP transport failure.
    #[error("http: {0}")]
    Http(#[from] HttpError),

    /// Dependency-graph failure.
    #[error("dependency: {0}")]
    Dependency(#[from] DependencyError),

    /// Cross-file dependency-graph failure.
    #[error("cross-file dependency: {0}")]
    CrossFileDependency(#[from] CrossFileDependencyError),

    /// File-registry failure.
    #[error("registry: {0}")]
    FileRegistry(#[from] FileRegistryError),

    /// Perf engine failure.
    #[error("perf: {0}")]
    Perf(#[from] PerfError),

    /// Database driver failure (Database Explorer tool).
    #[error("db: {0}")]
    Db(#[from] DbError),

    /// Tauri framework error.
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),

    /// Catch-all for ad-hoc errors (`anyhow::Error`).
    #[error("{0}")]
    Other(String),

    /// Caller passed an argument the command can't satisfy.
    #[error("{0}")]
    BadRequest(String),

    /// State that should exist for this command does not (e.g. no working
    /// directory selected yet).
    #[error("{0}")]
    NotInitialised(String),
}

impl AppError {
    /// Short stable kind string for the front-end.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Parser(_) => "parser",
            AppError::Http(_) => "http",
            AppError::Dependency(_) => "dependency",
            AppError::CrossFileDependency(_) => "crossFileDependency",
            AppError::FileRegistry(_) => "fileRegistry",
            AppError::Perf(_) => "perf",
            AppError::Db(_) => "db",
            AppError::Tauri(_) => "tauri",
            AppError::Other(_) => "other",
            AppError::BadRequest(_) => "badRequest",
            AppError::NotInitialised(_) => "notInitialised",
        }
    }
}

/// Serialise as `{ kind, message }` so the front-end can branch on `kind`.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(format!("json: {e}"))
    }
}

/// Convenience alias used by every Tauri command.
pub type AppResult<T> = Result<T, AppError>;
