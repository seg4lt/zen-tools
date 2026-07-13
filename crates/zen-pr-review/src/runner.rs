//! Claude child-process supervisor for AI reviews.
//!
//! Spawns `claude -p <prompt> --output-format stream-json --verbose
//! --model <m> --allowedTools "..." --disallowedTools "..."` with the
//! given worktree as the working directory and pipes stdout through a
//! line buffer. Each line goes through [`crate::events::classify_line`]
//! and is forwarded to the on-event callback.
//!
//! Cancellation listens on a `tokio::sync::Notify`; receiving a notify
//! signals the loop to kill the child (SIGTERM via `Child::kill()` is
//! enough on the platforms we target — `kill_on_drop(true)` covers
//! the rest). A wall-clock timeout of [`MAX_RUN_SECS`] also kills the
//! child to keep runaway sessions from soaking the user's machine.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{ReviewError, ReviewResult};
use crate::events::{classify_line, AiReviewEvent};

/// Hard wall-clock cap for a single review (30 minutes). Tuned for
/// substantial PRs without leaving a runaway session burning cost
/// indefinitely.
pub const MAX_RUN_SECS: u64 = 30 * 60;

/// What the runner reports back when the child exits.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// `true` if the child exited 0.
    pub success: bool,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
    /// Optional cost in USD parsed from a final `result` event.
    pub cost_usd: Option<f64>,
    /// Captured stderr (truncated).
    pub stderr_tail: String,
}

/// Trait so the runner can emit events without depending on the
/// registry directly. The Tauri layer also uses it to emit Tauri
/// events to the webview.
pub trait EventSink: Send + Sync + 'static {
    /// Forward one classified event.
    fn emit(&self, event: AiReviewEvent);
}

impl<F> EventSink for F
where
    F: Fn(AiReviewEvent) + Send + Sync + 'static,
{
    fn emit(&self, event: AiReviewEvent) {
        self(event)
    }
}

/// Spawn `claude` against the given worktree and stream classified
/// events to `sink` until the child exits, the cancel notifier fires,
/// or [`MAX_RUN_SECS`] elapses.
///
/// The function returns once the child has exited; long-lived callers
/// should `tokio::spawn` it.
pub async fn spawn_claude<S: EventSink>(
    worktree: PathBuf,
    prompt: String,
    model: Option<String>,
    cancel: Arc<Notify>,
    sink: S,
) -> ReviewResult<RunOutcome> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt,
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--allowedTools".into(),
        "Read Grep Glob Bash WebFetch".into(),
        "--disallowedTools".into(),
        "Edit Write MultiEdit NotebookEdit".into(),
    ];
    if let Some(m) = model.as_deref() {
        if !m.is_empty() {
            args.push("--model".into());
            args.push(m.to_string());
        }
    }

    let path = augmented_path();
    let started = Instant::now();
    tracing::info!(
        worktree = %worktree.display(),
        model = ?model,
        "spawning claude for ai review"
    );
    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .current_dir(&worktree)
        .env("PATH", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            sink.emit(AiReviewEvent::Error {
                message:
                    "Claude CLI not found on PATH. Install from https://claude.com/claude-code."
                        .into(),
            });
            return Err(ReviewError::Other(
                "claude CLI not on PATH (install Claude Code)".into(),
            ));
        }
        Err(e) => {
            sink.emit(AiReviewEvent::Error {
                message: format!("Failed to launch claude: {e}"),
            });
            return Err(ReviewError::Io(e));
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ReviewError::Other("claude child has no stdout pipe".into()))?;
    let stderr = child.stderr.take();
    let stderr_handle = stderr.map(|stderr| {
        tokio::spawn(async move {
            // Cap stderr at 8 KiB so we never soak memory on a runaway child.
            let mut buf = vec![0u8; 8 * 1024];
            let mut reader = BufReader::new(stderr);
            let n = reader.read(&mut buf).await.unwrap_or(0);
            buf.truncate(n);
            String::from_utf8_lossy(&buf).into_owned()
        })
    });

    let mut reader = BufReader::new(stdout).lines();
    let timeout = tokio::time::sleep(Duration::from_secs(MAX_RUN_SECS));
    tokio::pin!(timeout);

    let mut last_cost: Option<f64> = None;
    let mut last_duration_ms: u64 = 0;
    let mut stderr_tail = String::new();

    let exit_status = loop {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                tracing::info!("ai-review: cancel received; killing claude child");
                let _ = child.kill().await;
                let _ = child.wait().await;
                sink.emit(AiReviewEvent::Error { message: "Review cancelled.".into() });
                if let Some(handle) = stderr_handle {
                    if let Ok(s) = handle.await { stderr_tail = s; }
                }
                let _ = stderr_tail; // surfaced via tracing if needed
                return Err(ReviewError::Cancelled);
            }
            _ = &mut timeout => {
                tracing::warn!(secs = MAX_RUN_SECS, "ai-review: timeout reached; killing claude child");
                let _ = child.kill().await;
                let _ = child.wait().await;
                sink.emit(AiReviewEvent::Error {
                    message: format!("Review timed out after {MAX_RUN_SECS} seconds.")
                });
                if let Some(handle) = stderr_handle {
                    if let Ok(s) = handle.await { stderr_tail = s; }
                }
                let _ = stderr_tail;
                return Err(ReviewError::Timeout { secs: MAX_RUN_SECS });
            }
            line = reader.next_line() => {
                match line {
                    Ok(Some(text)) => {
                        for event in classify_line(&text) {
                            if let AiReviewEvent::Done { cost_usd, duration_ms, .. } = &event {
                                last_cost = *cost_usd;
                                last_duration_ms = *duration_ms;
                            }
                            sink.emit(event);
                        }
                    }
                    Ok(None) => {
                        // EOF — wait for exit and break out.
                        break child.wait().await?;
                    }
                    Err(e) => {
                        sink.emit(AiReviewEvent::Error {
                            message: format!("Reading claude stdout failed: {e}")
                        });
                        let _ = child.kill().await;
                        break child.wait().await?;
                    }
                }
            }
        }
    };

    if let Some(handle) = stderr_handle {
        if let Ok(s) = handle.await {
            stderr_tail = s;
        }
    }

    let duration_ms = if last_duration_ms > 0 {
        last_duration_ms
    } else {
        started.elapsed().as_millis() as u64
    };
    let success = exit_status.success();
    if !success {
        tracing::warn!(
            code = exit_status.code(),
            stderr = %stderr_tail.chars().take(400).collect::<String>(),
            "claude child exited non-zero"
        );
    }
    Ok(RunOutcome {
        success,
        duration_ms,
        cost_usd: last_cost,
        stderr_tail,
    })
}

/// Compute the same PATH list `zen_shell::ShellExecutor::new` uses, so
/// a GUI-launched app can find `claude` installed via Homebrew, npm,
/// or `~/.claude/local`. We rebuild it here (instead of using
/// `ShellExecutor`) because the executor is one-shot and we need a
/// long-lived child with a streaming stdout pipe.
fn augmented_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut parts: Vec<String> = vec![
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/local/sbin".into(),
        "/opt/local/bin".into(),
        "/opt/local/sbin".into(),
        home.join(".local/bin").to_string_lossy().into_owned(),
        home.join("bin").to_string_lossy().into_owned(),
        home.join(".nix-profile/bin").to_string_lossy().into_owned(),
        home.join(".npm-global/bin").to_string_lossy().into_owned(),
        home.join(".claude/local").to_string_lossy().into_owned(),
    ];
    parts.push(std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
    parts.join(":")
}
