//! Provider-level selection for dictation.
//!
//! Currently only one backend is available:
//!
//! * `"whisper"` — vendored whisper.cpp + ggml. Pairs with one of the
//!   seven `ModelId` variants for the on-disk weight choice.

use serde::{Deserialize, Serialize};

use crate::error::DictationError;

/// Top-level transcription backend the user has selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    /// Vendored whisper.cpp. Pairs with a [`crate::models::ModelId`]
    /// for the specific weight file.
    Whisper,
}

impl Provider {
    /// Kebab-case wire identifier (mirrors the `Serialize` output).
    pub const fn as_wire(self) -> &'static str {
        match self {
            Provider::Whisper => "whisper",
        }
    }

    /// Parse from the wire id. Mirror of [`Provider::as_wire`].
    pub fn parse(s: &str) -> Result<Self, DictationError> {
        Ok(match s {
            "whisper" => Provider::Whisper,
            // Legacy apple-speech value: fall back to whisper gracefully.
            "apple-speech" | _ => Provider::Whisper,
        })
    }

    /// Human-friendly label for the settings UI.
    pub const fn label(self) -> &'static str {
        match self {
            Provider::Whisper => "Whisper (whisper.cpp)",
        }
    }

    /// One-line subtitle for the settings UI.
    pub const fn description(self) -> &'static str {
        match self {
            Provider::Whisper => {
                "Open-source whisper.cpp. Pick a model size below; weights are downloaded once."
            }
        }
    }
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Whisper
    }
}
