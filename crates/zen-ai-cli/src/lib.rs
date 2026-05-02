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

/// Captured AI response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    /// Model output (Markdown).
    pub text: String,
    /// Reported cost in USD when the provider exposes it (Claude does;
    /// Copilot does not).
    #[serde(default)]
    pub cost_usd: Option<f64>,
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

#[derive(Debug, Deserialize)]
struct ClaudeJsonResponse {
    result: String,
    #[serde(default)]
    cost_usd: Option<f64>,
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
        if let Some(m) = model {
            if !m.is_empty() {
                args.push("--model".into());
                args.push(m.to_string());
            }
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = self.exec.run("claude", &arg_refs).await?;
        let parsed: ClaudeJsonResponse = serde_json::from_str(&out.stdout)
            .map_err(|e| AiError::Parse(format!("claude json: {e}")))?;
        Ok(AiResponse {
            text: parsed.result,
            cost_usd: parsed.cost_usd,
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
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = self.exec.run("copilot", &arg_refs).await?;
        let cleaned = filter_copilot_usage(&out.stdout);
        Ok(AiResponse {
            text: cleaned.trim().to_string(),
            cost_usd: None,
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
