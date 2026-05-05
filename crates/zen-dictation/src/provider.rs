//! Provider-level selection between Apple Speech and Whisper.
//!
//! Sits a layer above [`crate::models::ModelId`]: a `Provider` picks
//! the *backend*, and `ModelId` (only meaningful for the Whisper
//! provider) picks the model variant within that backend.
//!
//! The wire form is kebab-case so the persisted user-config and the
//! frontend dropdown round-trip the same string:
//!
//! * `"apple-speech"` — Apple's macOS 26 `SpeechAnalyzer` +
//!   `DictationTranscriber` stack. No model variant; locale-driven.
//! * `"whisper"` — vendored whisper.cpp + ggml. Pairs with one of the
//!   seven `ModelId` variants for the on-disk weight choice.

use serde::{Deserialize, Serialize};

use crate::error::DictationError;

/// Top-level transcription backend the user has selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    /// Apple's on-device speech stack from macOS 26+ (Tahoe). Uses
    /// `SpeechAnalyzer` + `DictationTranscriber`. No app-bundle
    /// download — locale models live in the system-wide
    /// `AssetInventory`.
    AppleSpeech,
    /// Vendored whisper.cpp. Pairs with a [`crate::models::ModelId`]
    /// for the specific weight file.
    Whisper,
}

impl Provider {
    /// Kebab-case wire identifier (mirrors the `Serialize` output).
    pub const fn as_wire(self) -> &'static str {
        match self {
            Provider::AppleSpeech => "apple-speech",
            Provider::Whisper => "whisper",
        }
    }

    /// Parse from the wire id. Mirror of [`Provider::as_wire`].
    pub fn parse(s: &str) -> Result<Self, DictationError> {
        Ok(match s {
            "apple-speech" => Provider::AppleSpeech,
            "whisper" => Provider::Whisper,
            other => return Err(DictationError::UnknownModel(other.to_string())),
        })
    }

    /// Human-friendly label for the settings UI.
    pub const fn label(self) -> &'static str {
        match self {
            Provider::AppleSpeech => "Apple Speech",
            Provider::Whisper => "Whisper (whisper.cpp)",
        }
    }

    /// One-line subtitle for the settings UI.
    pub const fn description(self) -> &'static str {
        match self {
            Provider::AppleSpeech => {
                "On-device, faster, no per-app download. Requires macOS 26+."
            }
            Provider::Whisper => {
                "Open-source whisper.cpp. Pick a model size below; weights are downloaded once."
            }
        }
    }
}

impl Default for Provider {
    /// Default backend when the user has never expressed a preference.
    /// **New installs** running macOS 26+ start on Apple Speech; older
    /// systems and existing installs (which already have a
    /// `dictation.selected_model` row in the KV store) are nudged onto
    /// Whisper by the call site, not by this default.
    fn default() -> Self {
        Provider::AppleSpeech
    }
}
