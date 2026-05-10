//! Streaming events emitted while a Claude review is in flight.
//!
//! Claude Code's `--output-format stream-json --verbose` mode prints
//! one JSON object per line. We classify each line into one of a small
//! handful of UI-friendly event variants so the frontend never has to
//! peek inside the raw protocol. Schema-drift safety is the priority:
//! anything we can't recognise becomes an [`AiReviewEvent::Stdout`]
//! variant rather than a panic.

use serde::{Deserialize, Serialize};

/// One unit of streaming output from a Claude review run.
///
/// Variants are tagged with `kind` on the wire so the frontend's
/// discriminated-union TypeScript type lines up with the Rust enum
/// without additional adapter code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiReviewEvent {
    /// Raw stdout line — emitted when classification fails or when the
    /// CLI prints something outside the protocol (e.g. a pre-banner).
    Stdout {
        /// The literal line, no trailing newline.
        line: String,
    },
    /// Claude shared an internal "thinking" chain.
    Thought {
        /// Body of the thinking block.
        text: String,
    },
    /// Claude invoked a tool (Read / Grep / Bash / …).
    ToolUse {
        /// Tool name (e.g. `"Bash"`, `"Read"`).
        name: String,
        /// Truncated, pretty-printed tool input for the UI to render.
        input_preview: String,
    },
    /// A previous tool call returned with output.
    ToolResult {
        /// Tool name the result corresponds to (best-effort; `""` if
        /// the protocol didn't include it on this turn).
        name: String,
        /// Truncated, pretty-printed tool output for the UI to render.
        output_preview: String,
        /// `true` when the tool reported an error.
        is_error: bool,
    },
    /// Plain text Claude sent back to the user (intermediate or final).
    Text {
        /// Body of the text block.
        text: String,
    },
    /// Run finished successfully.
    Done {
        /// Reported cost in USD when the CLI exposes one.
        #[serde(default)]
        cost_usd: Option<f64>,
        /// Wall-clock duration in milliseconds.
        duration_ms: u64,
        /// Path on disk to the persisted HTML report (relative paths
        /// are resolved by the Tauri layer when serving the file).
        report_path: Option<String>,
        /// Number of findings detected, when available.
        #[serde(default)]
        findings_count: Option<u32>,
    },
    /// Run failed before finishing (CLI crash, timeout, missing report,
    /// etc). The frontend keeps the streaming log visible so the user
    /// can see what happened.
    Error {
        /// Human-readable cause.
        message: String,
    },
}

/// Maximum characters we keep for a single tool input/output preview.
/// Anything longer is truncated with a `…` suffix to keep the IPC
/// payload small and the webview log readable. Coalescing in the
/// runner further caps the per-second event rate.
pub const PREVIEW_MAX_CHARS: usize = 1_200;

/// Truncate `s` to [`PREVIEW_MAX_CHARS`] characters, appending `…` when
/// we cut anything off. Operates on `chars()` so we never split a
/// multi-byte UTF-8 sequence.
pub fn truncate_preview(s: &str) -> String {
    let mut out = String::new();
    for (idx, ch) in s.chars().enumerate() {
        if idx >= PREVIEW_MAX_CHARS {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

/// Classify one JSONL line emitted by `claude --output-format stream-json`.
///
/// The protocol is documented at <https://docs.claude.com/en/docs/claude-code/sdk>;
/// the pieces we care about are:
///
/// * `{"type": "assistant", "message": {"content": [{"type": "thinking" | "text" | "tool_use", ...}]}}`
/// * `{"type": "user", "message": {"content": [{"type": "tool_result", ...}]}}`
/// * `{"type": "result", "subtype": "success", "duration_ms": ..., "total_cost_usd": ..., ...}`
///
/// We extract one or more events per line so a single assistant turn
/// with a thought + a tool call surfaces as two visible rows in the
/// UI. Anything we don't recognise becomes an [`AiReviewEvent::Stdout`].
pub fn classify_line(line: &str) -> Vec<AiReviewEvent> {
    let trimmed = line.trim_end_matches('\n');
    if trimmed.is_empty() {
        return Vec::new();
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            return vec![AiReviewEvent::Stdout {
                line: trimmed.to_string(),
            }];
        }
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => {
            return vec![AiReviewEvent::Stdout {
                line: trimmed.to_string(),
            }];
        }
    };
    let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "assistant" => classify_assistant(obj),
        "user" => classify_user(obj),
        "result" => vec![classify_result(obj)],
        // System / metadata frames carry no user-visible signal.
        "system" | "init" | "session" => Vec::new(),
        _ => vec![AiReviewEvent::Stdout {
            line: trimmed.to_string(),
        }],
    }
}

fn classify_assistant(obj: &serde_json::Map<String, serde_json::Value>) -> Vec<AiReviewEvent> {
    let Some(message) = obj.get("message").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let Some(content) = message.get("content").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(content.len());
    for item in content {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        match item_obj.get("type").and_then(|v| v.as_str()) {
            Some("thinking") => {
                let text = item_obj
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !text.is_empty() {
                    out.push(AiReviewEvent::Thought { text });
                }
            }
            Some("text") => {
                let text = item_obj
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !text.is_empty() {
                    out.push(AiReviewEvent::Text { text });
                }
            }
            Some("tool_use") => {
                let name = item_obj
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = item_obj
                    .get("input")
                    .map(|v| serde_json::to_string(v).unwrap_or_default())
                    .unwrap_or_default();
                out.push(AiReviewEvent::ToolUse {
                    name,
                    input_preview: truncate_preview(&input),
                });
            }
            _ => {}
        }
    }
    out
}

fn classify_user(obj: &serde_json::Map<String, serde_json::Value>) -> Vec<AiReviewEvent> {
    let Some(message) = obj.get("message").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let Some(content) = message.get("content").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in content {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        if item_obj.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
            continue;
        }
        let name = item_obj
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let is_error = item_obj
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let body = item_obj
            .get("content")
            .map(stringify_tool_content)
            .unwrap_or_default();
        out.push(AiReviewEvent::ToolResult {
            name,
            output_preview: truncate_preview(&body),
            is_error,
        });
    }
    out
}

fn stringify_tool_content(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .and_then(|o| o.get("text"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| Some(item.to_string()))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn classify_result(obj: &serde_json::Map<String, serde_json::Value>) -> AiReviewEvent {
    let cost_usd = obj
        .get("total_cost_usd")
        .or_else(|| obj.get("cost_usd"))
        .and_then(|v| v.as_f64());
    let duration_ms = obj
        .get("duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let subtype = obj.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
    if subtype == "success" {
        AiReviewEvent::Done {
            cost_usd,
            duration_ms,
            report_path: None,
            findings_count: None,
        }
    } else {
        let message = obj
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Claude returned a non-success result")
            .to_string();
        AiReviewEvent::Error { message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_thinking_and_tool_use_in_one_assistant_turn() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "let me trace this"},
                    {"type": "tool_use", "name": "Read", "input": {"file_path": "/tmp/x"}}
                ]
            }
        })
        .to_string();
        let events = classify_line(&line);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], AiReviewEvent::Thought { text } if text == "let me trace this"));
        assert!(matches!(&events[1], AiReviewEvent::ToolUse { name, .. } if name == "Read"));
    }

    #[test]
    fn classifies_tool_result_with_error_flag() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "Bash", "content": "boom", "is_error": true}
                ]
            }
        })
        .to_string();
        let events = classify_line(&line);
        match &events[0] {
            AiReviewEvent::ToolResult { is_error, output_preview, .. } => {
                assert!(*is_error);
                assert_eq!(output_preview, "boom");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn classifies_result_success() {
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "duration_ms": 4321u64,
            "total_cost_usd": 0.42
        })
        .to_string();
        let events = classify_line(&line);
        match &events[0] {
            AiReviewEvent::Done { cost_usd, duration_ms, .. } => {
                assert_eq!(*cost_usd, Some(0.42));
                assert_eq!(*duration_ms, 4321);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn unknown_shape_falls_back_to_stdout() {
        let line = "not even json";
        let events = classify_line(line);
        match &events[0] {
            AiReviewEvent::Stdout { line: l } => assert_eq!(l, "not even json"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn truncate_preview_keeps_short_strings_intact() {
        assert_eq!(truncate_preview("hello"), "hello");
    }

    #[test]
    fn truncate_preview_handles_multibyte_chars() {
        let long: String = "✨".repeat(PREVIEW_MAX_CHARS + 50);
        let out = truncate_preview(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), PREVIEW_MAX_CHARS + 1);
    }
}
