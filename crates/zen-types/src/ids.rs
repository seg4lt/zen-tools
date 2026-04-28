//! Lightweight newtype wrappers for identifiers that flow through the app.
//!
//! Each newtype wraps an `Arc<str>` so that cloning is a single atomic
//! refcount bump regardless of string length — the original code used owned
//! `String`s in hot paths (HashMap keys, channel messages), which copied on
//! every clone.

use serde::{Deserialize, Serialize};
use std::{borrow::Borrow, fmt, sync::Arc};

/// Stable request identifier (typically `"<source_file>:<name>"`).
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RequestId(Arc<str>);

impl RequestId {
    /// Construct from any string-like value.
    pub fn new(s: impl Into<Arc<str>>) -> Self {
        Self(s.into())
    }

    /// Borrow as `&str`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for RequestId {
    fn from(s: String) -> Self {
        Self(Arc::from(s.into_boxed_str()))
    }
}

impl From<&str> for RequestId {
    fn from(s: &str) -> Self {
        Self(Arc::from(s))
    }
}

impl Borrow<str> for RequestId {
    fn borrow(&self) -> &str {
        &self.0
    }
}

/// Environment-name newtype.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EnvName(Arc<str>);

impl EnvName {
    /// Construct from any string-like value.
    pub fn new(s: impl Into<Arc<str>>) -> Self {
        Self(s.into())
    }

    /// Borrow as `&str`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for EnvName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for EnvName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for EnvName {
    fn from(s: String) -> Self {
        Self(Arc::from(s.into_boxed_str()))
    }
}

impl From<&str> for EnvName {
    fn from(s: &str) -> Self {
        Self(Arc::from(s))
    }
}

impl Borrow<str> for EnvName {
    fn borrow(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_clone_is_cheap() {
        let id = RequestId::new("api.http:GetUsers");
        let clone = id.clone();
        // Pointer equality of the inner Arc — confirms we are not deep-copying.
        assert!(Arc::ptr_eq(&id.0, &clone.0));
    }
}
