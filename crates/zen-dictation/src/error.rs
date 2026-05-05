//! Error type for the dictation crate.

use thiserror::Error;

/// All failures the dictation pipeline can raise.
#[derive(Debug, Error)]
pub enum DictationError {
    /// Underlying whisper.cpp wrapper failure.
    #[error("whisper: {0}")]
    Whisper(#[from] zen_whisper::WhisperError),

    /// Apple Speech bridge failure (passed-through Swift error).
    #[error("apple speech bridge: {0}")]
    AppleSpeechBridge(#[from] zen_apple_speech::AppleSpeechError),

    /// Audio capture / device failure.
    #[error("audio: {0}")]
    Audio(String),

    /// Model download failure.
    #[error("download: {0}")]
    Download(String),

    /// HTTP transport error (download).
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    /// Filesystem I/O.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// The platform we're compiled for has no implementation for the
    /// requested operation (e.g. hotkey watcher on Linux).
    #[error("not supported on this platform")]
    NotSupported,

    /// Caller attempted an action that requires an already-loaded
    /// model.
    #[error("no model is loaded")]
    NoModel,

    /// Caller passed an invalid model id.
    #[error("unknown model id: {0}")]
    UnknownModel(String),
}
