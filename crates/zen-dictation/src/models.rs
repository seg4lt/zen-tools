//! Whisper model registry — id, label, size hint, description, and
//! download URL.
//!
//! All model files live at the same Hugging Face mirror used by every
//! whisper.cpp project: `huggingface.co/ggerganov/whisper.cpp/...`.
//! Files are stored on disk as `<models_dir>/ggml-<filename>.bin`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::DictationError;

/// Stable identifier for a downloadable Whisper model. The string
/// representation is the wire format we round-trip with the frontend
/// (lowercase, dash-separated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelId {
    /// Smallest English/multilingual model (~75 MB).
    Tiny,
    /// Default — balanced size/accuracy (~150 MB).
    Base,
    /// Mid-size, more accurate than Base (~500 MB).
    Small,
    /// Large vocabulary (~1.5 GB).
    Medium,
    /// Latest large-v3 — highest accuracy, slowest (~3.0 GB).
    LargeV3,
    /// Hugging Face's distilled large-v3 — large-v3 quality at ~½ the
    /// size and ~2× the speed (~1.5 GB).
    DistilLargeV3,
    /// Optimised "turbo" variant of large-v3 (~1.5 GB) — faster than
    /// vanilla large-v3 with similar accuracy.
    LargeV3Turbo,
}

impl ModelId {
    /// All models, ordered fastest → slowest. The dropdown in Settings
    /// displays them in this order.
    pub const fn all_fast_to_slow() -> &'static [ModelId] {
        &[
            ModelId::Tiny,
            ModelId::Base,
            ModelId::Small,
            ModelId::Medium,
            ModelId::LargeV3Turbo,
            ModelId::DistilLargeV3,
            ModelId::LargeV3,
        ]
    }

    /// The kebab-case wire identifier (mirrors the `Serialize` output).
    pub const fn as_wire(self) -> &'static str {
        match self {
            ModelId::Tiny => "tiny",
            ModelId::Base => "base",
            ModelId::Small => "small",
            ModelId::Medium => "medium",
            ModelId::LargeV3 => "large-v3",
            ModelId::DistilLargeV3 => "distil-large-v3",
            ModelId::LargeV3Turbo => "large-v3-turbo",
        }
    }

    /// Parse from the wire id; mirror of [`as_wire`].
    pub fn parse(s: &str) -> Result<Self, DictationError> {
        Ok(match s {
            "tiny" => ModelId::Tiny,
            "base" => ModelId::Base,
            "small" => ModelId::Small,
            "medium" => ModelId::Medium,
            "large-v3" => ModelId::LargeV3,
            "distil-large-v3" => ModelId::DistilLargeV3,
            "large-v3-turbo" => ModelId::LargeV3Turbo,
            other => return Err(DictationError::UnknownModel(other.to_string())),
        })
    }

    /// Human-friendly display label for the dropdown.
    pub const fn label(self) -> &'static str {
        match self {
            ModelId::Tiny => "Whisper Tiny",
            ModelId::Base => "Whisper Base",
            ModelId::Small => "Whisper Small",
            ModelId::Medium => "Whisper Medium",
            ModelId::LargeV3 => "Whisper Large v3",
            ModelId::DistilLargeV3 => "Distil-Whisper Large v3",
            ModelId::LargeV3Turbo => "Whisper Large v3 Turbo",
        }
    }

    /// Approximate on-disk size (rendered as a sub-label in the
    /// dropdown). These are pulled from the Hugging Face listing for
    /// each model and are intentionally rounded.
    pub const fn size_label(self) -> &'static str {
        match self {
            ModelId::Tiny => "~75 MB",
            ModelId::Base => "~150 MB",
            ModelId::Small => "~500 MB",
            ModelId::Medium => "~1.5 GB",
            ModelId::LargeV3 => "~3.0 GB",
            ModelId::DistilLargeV3 => "~1.5 GB",
            ModelId::LargeV3Turbo => "~1.5 GB",
        }
    }

    /// One-line description for the dropdown subtitle.
    pub const fn description(self) -> &'static str {
        match self {
            ModelId::Tiny => "Smallest, fastest. Good for short, clear speech.",
            ModelId::Base => "Balanced size and accuracy — recommended default.",
            ModelId::Small => "Better accuracy on accents and noisy audio.",
            ModelId::Medium => "Strong accuracy across most languages.",
            ModelId::LargeV3 => "Highest accuracy. Slowest inference.",
            ModelId::DistilLargeV3 => "Distilled large-v3: ~2× faster, similar quality (English-focused).",
            ModelId::LargeV3Turbo => "Faster large-v3 variant with similar accuracy.",
        }
    }

    /// Whether this is the recommended default downloaded on first
    /// enable.
    pub const fn is_default(self) -> bool {
        matches!(self, ModelId::Base)
    }

    /// Filename component used both in the Hugging Face URL
    /// (`ggml-<basename>.bin`) and the on-disk filename.
    pub const fn filename_basename(self) -> &'static str {
        match self {
            ModelId::Tiny => "tiny",
            ModelId::Base => "base",
            ModelId::Small => "small",
            ModelId::Medium => "medium",
            ModelId::LargeV3 => "large-v3",
            ModelId::DistilLargeV3 => "large-v3-distil",
            ModelId::LargeV3Turbo => "large-v3-turbo",
        }
    }

    /// Hugging Face download URL for the ggml weight file.
    pub fn download_url(self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
            self.filename_basename()
        )
    }

    /// Final on-disk filename inside `<models_dir>`.
    pub fn filename(self) -> String {
        format!("ggml-{}.bin", self.filename_basename())
    }

    /// Resolve the on-disk path for this model under `models_dir`.
    pub fn path_in(self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.filename())
    }
}

/// Snapshot of whether a model's weights are currently on disk.
#[derive(Debug, Clone)]
pub struct ModelStatus {
    /// The model id.
    pub id: ModelId,
    /// `true` when the `.bin` file exists at the resolved path.
    pub downloaded: bool,
}
