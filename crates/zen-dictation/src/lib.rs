//! Local dictation primitives: microphone capture, model download,
//! hotkey watcher, paste-at-cursor.
//!
//! The Tauri layer (`src-tauri/src/dictation/`) wires these primitives
//! into the React frontend via Tauri commands and global state. This
//! crate has no Tauri dependency itself so it can be unit-tested in
//! isolation.
//!
//! ## Cross-platform
//!
//! Today only macOS implementations are wired up (mic + hotkey +
//! paste). Each platform-specific submodule (`hotkey/macos.rs`,
//! `paste/macos.rs`) is gated on `#[cfg(target_os = "macos")]`; the
//! parent `mod.rs` of each exposes a common API and dispatches at the
//! cfg layer. Adding Linux/Windows means adding sibling files.

#![warn(missing_docs)]

pub mod download;
pub mod error;
pub mod hotkey;
pub mod manager;
pub mod mic;
pub mod models;
pub mod paste;

pub use error::DictationError;
pub use manager::{DictationManager, HotkeyEvent};
pub use models::{ModelId, ModelStatus};
