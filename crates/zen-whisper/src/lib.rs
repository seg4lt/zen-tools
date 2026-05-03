//! Safe Rust wrapper around vendored whisper.cpp.
//!
//! The vendored upstream sources live under `vendor/whisper.cpp/`
//! (pinned to upstream `v1.7.4`). `build.rs` compiles the C/C++ + the
//! macOS Metal Obj-C backend and runs `bindgen` against `whisper.h`.
//!
//! Cross-platform shape:
//!
//! * On `target_os = "macos"` we link against Metal + Accelerate and
//!   expose the real implementation in [`context::WhisperContext`].
//! * On other platforms the FFI module is empty and
//!   [`context::WhisperContext`] becomes a stub whose methods all
//!   return [`error::WhisperError::NotSupported`]. This keeps the
//!   workspace compiling on Linux/Windows for `cargo check`; we'll
//!   fill in CPU/CUDA/Vulkan backends in a follow-up.

#![warn(missing_docs)]

#[cfg(target_os = "macos")]
#[allow(
    non_upper_case_globals,
    non_camel_case_types,
    non_snake_case,
    dead_code,
    clippy::all
)]
pub(crate) mod sys {
    include!(concat!(env!("OUT_DIR"), "/whisper_bindings.rs"));
}

pub mod context;
pub mod error;

pub use context::WhisperContext;
pub use error::WhisperError;
