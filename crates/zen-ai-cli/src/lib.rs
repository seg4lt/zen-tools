//! Pluggable adapters for the `claude` and `copilot` CLI programs.
//!
//! Direct port of the Swift `ClaudeProvider` / `CopilotProvider` /
//! `AIProviderConfig` types. Both adapters shell out via [`zen_shell`]
//! with the same PATH augmentation as the rest of PRMaster, so binaries
//! installed via Homebrew / npm / nix are reliably found.
//!
//! Wire format:
//!   * **Claude**: `claude -p "<prompt>" --output-format json --max-turns 1 [--model <m>]`
//!     → JSON `{result, cost_usd, session_id}`.
//!   * **Copilot**: `copilot -p "<prompt>" [--model <m>]` → plain text
//!     with a trailing usage block we strip.

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zen_shell::{ShellError, ShellExecutor};

/// Which CLI to invoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderType {
    /// Anthropic's `claude` CLI (`claude -p ... --output-format json`).
    Claude,
    /// GitHub `copilot` CLI (`copilot -p ...`).
    Copilot,
}

impl AiProviderType {
    /// Provider tag used in `UserConfig`.
    pub fn as_wire(self) -> &'static str {
        match self {
            AiProviderType::Claude => "claude",
            AiProviderType::Copilot => "copilot",
        }
    }

    /// Inverse of [`as_wire`].
    pub fn from_wire(s: &str) -> Self {
        match s {
            "copilot" => AiProviderType::Copilot,
            _ => AiProviderType::Claude,
        }
    }
}

/// Per-model token-usage breakdown returned by Claude Code.
///
/// Claude Code uses the `--model` you pass for the actual completion
/// **but also** invokes a small Haiku model internally for things like
/// tool routing / classification, even when you've explicitly asked
/// for Sonnet or Opus. The CLI's JSON output reports tokens per model
/// in a `modelUsage` map; we surface it verbatim so the API Stats tab
/// can show the user **what models actually got billed** and rule out
/// "I configured Sonnet but Haiku ran" surprises (the answer is
/// usually "both — Haiku for the routing, Sonnet for the answer").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageEntry {
    /// Reported model identifier (e.g. `"claude-sonnet-4-20250514"`).
    pub model: String,
    /// Input tokens consumed by this model.
    #[serde(default)]
    pub input_tokens: Option<u64>,
    /// Output tokens emitted by this model.
    #[serde(default)]
    pub output_tokens: Option<u64>,
    /// Cache-read input tokens, when reported.
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    /// Cache-creation input tokens, when reported.
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    /// USD cost attributed to this model, when the CLI reports it.
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

/// Captured AI response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    /// Model output (Markdown).
    pub text: String,
    /// Reported cost in USD when the provider exposes it (Claude does;
    /// Copilot does not).
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Per-model token-usage breakdown when the provider reports one.
    /// Always empty for Copilot. For Claude Code this typically
    /// contains both the model you passed via `--model` and the
    /// internal Haiku used for routing.
    #[serde(default)]
    pub model_usage: Vec<ModelUsageEntry>,
}

/// Errors returned by AI provider implementations.
#[derive(Debug, Error)]
pub enum AiError {
    /// The underlying CLI shell-out failed.
    #[error(transparent)]
    Shell(#[from] ShellError),
    /// The CLI succeeded but its stdout could not be parsed.
    #[error("failed to parse AI provider output: {0}")]
    Parse(String),
}

/// Result alias used by [`AiProvider`].
pub type AiResult<T> = Result<T, AiError>;

/// Trait every CLI adapter implements.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// One-shot prompt → response.
    async fn summarise(&self, prompt: &str, model: Option<&str>) -> AiResult<AiResponse>;
    /// List the model identifiers the provider supports. Best-effort —
    /// adapters that can't introspect return a static list.
    async fn list_models(&self) -> AiResult<Vec<String>>;
    /// Provider tag (used in logs / settings).
    fn kind(&self) -> AiProviderType;
}

// ─── Claude ─────────────────────────────────────────────────────────────

/// `claude -p "<prompt>" --output-format json --max-turns 1` adapter.
#[derive(Clone, Debug)]
pub struct ClaudeCliProvider {
    exec: ShellExecutor,
}

impl ClaudeCliProvider {
    /// Build the adapter with the standard PATH-augmented executor and a
    /// 180-second timeout (matches Swift's `AIProviderConfig.claude.timeout`).
    pub fn new() -> Self {
        Self {
            exec: ShellExecutor::new().with_timeout(Duration::from_secs(180)),
        }
    }
}

impl Default for ClaudeCliProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Shape of the JSON Claude Code prints with `--output-format json`.
/// Field set covers v1+ outputs; unknown fields are silently ignored.
#[derive(Debug, Deserialize)]
struct ClaudeJsonResponse {
    /// The actual completion text. May be empty on `is_error: true`.
    result: String,
    /// Total billed cost. Some CLI versions name it `cost_usd`, others
    /// `total_cost_usd`. Accept either.
    #[serde(default, alias = "total_cost_usd")]
    cost_usd: Option<f64>,
    /// Per-model usage breakdown. Field name is camelCase
    /// (`modelUsage`) on the wire; alias both spellings.
    #[serde(default, alias = "model_usage", alias = "modelUsage")]
    model_usage: Option<serde_json::Value>,
}

/// Translate Claude's `modelUsage` JSON map (model id → usage object)
/// into the flat `Vec<ModelUsageEntry>` we surface upstream.
fn parse_model_usage(value: &serde_json::Value) -> Vec<ModelUsageEntry> {
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(map.len());
    for (model, raw) in map {
        let obj = raw.as_object();
        let pick_u64 = |key: &str| -> Option<u64> {
            obj.and_then(|m| m.get(key))
                .and_then(|v| v.as_u64())
        };
        let pick_f64 = |key: &str| -> Option<f64> {
            obj.and_then(|m| m.get(key))
                .and_then(|v| v.as_f64())
        };
        out.push(ModelUsageEntry {
            model: model.clone(),
            input_tokens: pick_u64("inputTokens").or_else(|| pick_u64("input_tokens")),
            output_tokens: pick_u64("outputTokens").or_else(|| pick_u64("output_tokens")),
            cache_read_input_tokens: pick_u64("cacheReadInputTokens")
                .or_else(|| pick_u64("cache_read_input_tokens")),
            cache_creation_input_tokens: pick_u64("cacheCreationInputTokens")
                .or_else(|| pick_u64("cache_creation_input_tokens")),
            cost_usd: pick_f64("costUSD")
                .or_else(|| pick_f64("cost_usd"))
                .or_else(|| pick_f64("totalCostUSD"))
                .or_else(|| pick_f64("total_cost_usd")),
        });
    }
    // Stable order: most output tokens first so the "real" answer model
    // sorts above the small Haiku routing entries.
    out.sort_by(|a, b| {
        b.output_tokens
            .unwrap_or(0)
            .cmp(&a.output_tokens.unwrap_or(0))
    });
    out
}

#[async_trait]
impl AiProvider for ClaudeCliProvider {
    async fn summarise(&self, prompt: &str, model: Option<&str>) -> AiResult<AiResponse> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            prompt.to_string(),
            "--output-format".into(),
            "json".into(),
            "--max-turns".into(),
            "1".into(),
        ];
        // The `--model` flag is the **single source of truth** Claude
        // Code looks at for which model to use. If we omit it (because
        // the user's settings.ai_model is empty), the CLI falls back
        // to its own default, which on recent versions is Haiku.
        // That's the most common cause of "I configured Sonnet but I
        // see Haiku" surprises — fix it by setting a model in
        // PRMaster → Settings → AI Model.
        if let Some(m) = model {
            if !m.is_empty() {
                args.push("--model".into());
                args.push(m.to_string());
            }
        }
        // Log args (with the prompt body redacted to a length so we
        // don't dump kilobytes per call) so users can verify the
        // resolved CLI invocation with `RUST_LOG=zen_ai_cli=debug`.
        tracing::debug!(
            target: "zen_ai_cli::claude",
            requested_model = ?model,
            cli_args = ?redact_prompt(&args),
            "claude summarise: invoking CLI",
        );
        let out = self.exec.run("claude", &args.iter().map(|s| s.as_str()).collect::<Vec<_>>()).await?;
        let parsed: ClaudeJsonResponse = serde_json::from_str(&out.stdout)
            .map_err(|e| AiError::Parse(format!("claude json: {e}")))?;
        let model_usage = parsed
            .model_usage
            .as_ref()
            .map(parse_model_usage)
            .unwrap_or_default();
        if !model_usage.is_empty() {
            tracing::debug!(
                target: "zen_ai_cli::claude",
                requested_model = ?model,
                returned_models = ?model_usage.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(),
                "claude summarise: per-model usage breakdown",
            );
        }
        Ok(AiResponse {
            text: parsed.result,
            cost_usd: parsed.cost_usd,
            model_usage,
        })
    }

    async fn list_models(&self) -> AiResult<Vec<String>> {
        Ok(vec![
            "sonnet".to_string(),
            "opus".to_string(),
            "haiku".to_string(),
        ])
    }

    fn kind(&self) -> AiProviderType {
        AiProviderType::Claude
    }
}

// ─── Copilot ────────────────────────────────────────────────────────────

/// `copilot -p "<prompt>"` adapter (GitHub Copilot CLI).
#[derive(Clone, Debug)]
pub struct CopilotCliProvider {
    exec: ShellExecutor,
}

impl CopilotCliProvider {
    /// Build with the standard PATH-augmented executor and a 180-second
    /// timeout.
    pub fn new() -> Self {
        Self {
            exec: ShellExecutor::new().with_timeout(Duration::from_secs(180)),
        }
    }
}

impl Default for CopilotCliProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AiProvider for CopilotCliProvider {
    async fn summarise(&self, prompt: &str, model: Option<&str>) -> AiResult<AiResponse> {
        let mut args: Vec<String> = vec!["-p".into(), prompt.to_string()];
        if let Some(m) = model {
            if !m.is_empty() {
                args.push("--model".into());
                args.push(m.to_string());
            }
        }
        tracing::debug!(
            target: "zen_ai_cli::copilot",
            requested_model = ?model,
            cli_args = ?redact_prompt(&args),
            "copilot summarise: invoking CLI",
        );
        let out = self
            .exec
            .run("copilot", &args.iter().map(|s| s.as_str()).collect::<Vec<_>>())
            .await?;
        let cleaned = filter_copilot_usage(&out.stdout);
        Ok(AiResponse {
            text: cleaned.trim().to_string(),
            cost_usd: None,
            // Copilot CLI doesn't expose a per-model usage breakdown.
            model_usage: Vec::new(),
        })
    }

    async fn list_models(&self) -> AiResult<Vec<String>> {
        // Mirror Swift's `fetchModels`: invoke with a deliberately invalid
        // model to force the CLI to print its supported list to stderr.
        let result = self
            .exec
            .run(
                "copilot",
                &[
                    "-p",
                    "__zen_probe__",
                    "--model",
                    "__zen_probe_invalid__",
                ],
            )
            .await;
        let blob = match result {
            Ok(out) => format!("{}\n{}", out.stdout, out.stderr),
            Err(ShellError::CommandFailed { output, .. }) => output,
            Err(e) => return Err(AiError::Shell(e)),
        };
        Ok(parse_copilot_models(&blob))
    }

    fn kind(&self) -> AiProviderType {
        AiProviderType::Copilot
    }
}

/// Strip Copilot's trailing "Total usage / Total duration" block from an
/// otherwise-plain-text response. Mirrors Swift's
/// `filterCopilotUsageStatistics`.
pub fn filter_copilot_usage(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    for i in 0..lines.len() {
        let trimmed = lines[i].trim_start();
        if trimmed.starts_with("Total usage") {
            if let Some(next) = lines.get(i + 1) {
                if next.trim_start().starts_with("Total duration") {
                    return lines[..i].join("\n");
                }
            }
        }
    }
    text.to_string()
}

/// Best-effort parse of Copilot's "supported models" error output.
/// Looks for backticked tokens; accepts comma- or whitespace-separated
/// fallbacks.
pub fn parse_copilot_models(blob: &str) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut in_tick = false;
    for ch in blob.chars() {
        if ch == '`' {
            if in_tick {
                let m = buf.trim().to_string();
                if !m.is_empty() && !models.contains(&m) {
                    models.push(m);
                }
                buf.clear();
                in_tick = false;
            } else {
                in_tick = true;
            }
        } else if in_tick {
            buf.push(ch);
        }
    }
    if !models.is_empty() {
        return models;
    }

    // Fallback: pull tokens after a `Supported models` heading.
    if let Some(idx) = blob.to_ascii_lowercase().find("supported model") {
        let tail = &blob[idx..];
        let line = tail.lines().next().unwrap_or("");
        for tok in line.split(|c: char| c == ',' || c.is_whitespace()) {
            let t = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '.');
            if !t.is_empty() && t.len() < 64 && !models.contains(&t.to_string()) {
                models.push(t.to_string());
            }
        }
    }
    models
}

/// Replace the long prompt body with `<prompt N chars>` so the
/// `tracing::debug!` of resolved CLI args stays readable instead of
/// dumping kilobytes of git-log into every log line. The prompt is the
/// argument that immediately follows `-p`.
fn redact_prompt(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut iter = args.iter().enumerate().peekable();
    while let Some((idx, a)) = iter.next() {
        out.push(a.clone());
        if a == "-p" {
            if let Some((_, body)) = iter.next() {
                out.push(format!("<prompt {} chars>", body.chars().count()));
                continue;
            }
        }
        let _ = idx;
    }
    out
}

/// Build a provider instance from the persisted settings tag.
pub fn build_provider(kind: AiProviderType) -> Box<dyn AiProvider> {
    match kind {
        AiProviderType::Claude => Box::new(ClaudeCliProvider::new()),
        AiProviderType::Copilot => Box::new(CopilotCliProvider::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_copilot_usage_strips_trailing_block() {
        let input = "Hello world\n\nTotal usage: 1 token\nTotal duration: 2.0s\n";
        let out = filter_copilot_usage(input);
        assert_eq!(out.trim(), "Hello world");
    }

    #[test]
    fn filter_copilot_usage_no_trailer_returned_verbatim() {
        let input = "Hello world\n";
        let out = filter_copilot_usage(input);
        assert_eq!(out, input);
    }

    #[test]
    fn parse_copilot_models_picks_backticked_tokens() {
        let blob =
            "error: model `__zen_probe_invalid__` not found. supported: `gpt-4`, `claude-3.5-sonnet`";
        let models = parse_copilot_models(blob);
        assert!(models.contains(&"gpt-4".to_string()));
        assert!(models.contains(&"claude-3.5-sonnet".to_string()));
    }
}
