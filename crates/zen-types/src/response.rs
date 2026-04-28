//! HTTP response and per-request execution-result types.
//!
//! The original TUI placed `perf_metrics: Option<MetricsSnapshot>` on
//! `RequestResult` to multiplex perf updates over the same channel. In the
//! Tauri port the perf and request streams are separate events, so this
//! crate is free of any dependency on `zen-perf`.

use ahash::HashMap;
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// A completed HTTP response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    /// Numeric status (e.g. 200).
    pub status_code: u16,
    /// Status reason phrase.
    pub status_text: String,
    /// Header map.
    pub headers: HashMap<String, String>,
    /// Response body as a UTF-8 string (lossy where needed).
    pub body: String,
    /// End-to-end duration of the request.
    #[serde(with = "duration_millis")]
    pub duration: Duration,
    /// Body size in bytes.
    pub size_bytes: usize,
}

mod duration_millis {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::time::Duration;

    pub fn serialize<S: Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
        (d.as_secs_f64() * 1000.0).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Duration, D::Error> {
        let ms = f64::deserialize(d)?;
        Ok(Duration::from_secs_f64(ms / 1000.0))
    }
}

impl HttpResponse {
    /// Human-readable duration ("123ms" or "1.45s").
    pub fn format_duration(&self) -> String {
        let ms = self.duration.as_millis();
        if ms < 1000 {
            format!("{ms}ms")
        } else {
            format!("{:.2}s", self.duration.as_secs_f64())
        }
    }

    /// Human-readable size ("128 B" / "1.2 KB" / "3.4 MB").
    pub fn format_size(&self) -> String {
        let b = self.size_bytes as f64;
        if self.size_bytes < 1024 {
            format!("{} B", self.size_bytes)
        } else if self.size_bytes < 1024 * 1024 {
            format!("{:.1} KB", b / 1024.0)
        } else {
            format!("{:.1} MB", b / (1024.0 * 1024.0))
        }
    }

    /// `true` for 2xx responses.
    pub const fn is_success(&self) -> bool {
        self.status_code >= 200 && self.status_code < 300
    }
}

/// Status of a single request execution. Adjacently tagged for ergonomic
/// TypeScript discrimination on the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecutionStatus {
    /// Not yet started.
    #[default]
    Idle,
    /// In flight; optional message such as "Executing dependency: Login".
    Running {
        /// Optional progress message.
        message: Option<String>,
    },
    /// Finished with an HTTP response.
    Success {
        /// The completed response.
        response: HttpResponse,
    },
    /// Finished with an error.
    Error {
        /// Error message.
        message: String,
    },
}

/// A single execution outcome — emitted to the frontend as
/// `request:result` events from the Tauri layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestResult {
    /// Stable id of the request (file:name).
    pub request_id: String,
    /// Current status.
    pub status: ExecutionStatus,
    /// Variables extracted from the response (per `# @extract`).
    pub extracted_vars: HashMap<String, String>,
    /// Optional log line shown in the bottom logs panel.
    pub log_message: Option<String>,
    /// Cookies set by the response (`(name, value)` pairs).
    pub new_cookies: Vec<(String, String)>,
    /// Wall-clock completion time.
    pub completed_at: Option<DateTime<Local>>,
}

impl RequestResult {
    /// Initial idle marker.
    pub fn idle(request_id: impl Into<String>) -> Self {
        Self::new(request_id, ExecutionStatus::Idle)
    }

    /// Running marker (no message).
    pub fn running(request_id: impl Into<String>) -> Self {
        Self::new(request_id, ExecutionStatus::Running { message: None })
    }

    /// Running marker with a progress message (e.g. dependency name).
    pub fn running_with_message(request_id: impl Into<String>, message: String) -> Self {
        Self::new(
            request_id,
            ExecutionStatus::Running {
                message: Some(message),
            },
        )
    }

    /// Success outcome.
    pub fn success(
        request_id: impl Into<String>,
        response: HttpResponse,
        extracted_vars: HashMap<String, String>,
        new_cookies: Vec<(String, String)>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            status: ExecutionStatus::Success { response },
            extracted_vars,
            log_message: None,
            new_cookies,
            completed_at: Some(Local::now()),
        }
    }

    /// Failure outcome.
    pub fn error(request_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            status: ExecutionStatus::Error {
                message: error.into(),
            },
            extracted_vars: HashMap::default(),
            log_message: None,
            new_cookies: Vec::new(),
            completed_at: Some(Local::now()),
        }
    }

    fn new(request_id: impl Into<String>, status: ExecutionStatus) -> Self {
        Self {
            request_id: request_id.into(),
            status,
            extracted_vars: HashMap::default(),
            log_message: None,
            new_cookies: Vec::new(),
            completed_at: None,
        }
    }
}
