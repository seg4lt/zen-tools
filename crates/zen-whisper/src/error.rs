//! Error type for the whisper.cpp wrapper.

use thiserror::Error;

/// Failures raised by [`crate::WhisperContext`].
#[derive(Debug, Error)]
pub enum WhisperError {
    /// The platform we're compiled for has no whisper.cpp backend wired
    /// up. Currently this means anything that isn't macOS.
    #[error("whisper backend not available on this platform")]
    NotSupported,

    /// The model file at the given path could not be loaded by
    /// `whisper_init_from_file_with_params`.
    #[error("failed to load model: {0}")]
    ModelLoad(String),

    /// `whisper_full` returned a non-zero status code.
    #[error("whisper_full failed: code={0}")]
    Inference(i32),

    /// Filesystem I/O error resolving the model path.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Empty/silent transcription (no segments returned). Treated as a
    /// soft error so callers can decide whether to silently ignore.
    #[error("no speech detected")]
    NoSpeech,
}
