//! Paste-at-cursor.
//!
//! macOS implementation lives in [`macos`]. Other platforms get a stub
//! that returns `NotSupported` so callers don't need cfg-walls.

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use macos::paste_text;

#[cfg(not(target_os = "macos"))]
pub fn paste_text(_text: &str) -> Result<(), crate::DictationError> {
    Err(crate::DictationError::NotSupported)
}
