//! General-purpose async child-process executor used by every zen-tools crate
//! that needs to shell out (`zen-github` for `gh`, `zen-ai-cli` for `claude` /
//! `copilot`, `zen-prmaster` for local `git`).
//!
//! The Swift PRMaster app shipped a single `ShellExecutor` actor that wrapped
//! `Foundation.Process` with PATH augmentation so GUI-launched apps could find
//! Homebrew / npm / nix binaries. This crate ports that idea to Rust on top of
//! `tokio::process::Command`, plus:
//!
//! * a configurable extra-PATH list (defaults match PRMaster),
//! * an enforced timeout that terminates the child,
//! * stdin piping (used to feed prompts to `claude -p`),
//! * a per-call working-directory override (used for local `git log` / `git
//!   show` against a user-mapped repo).
//!
//! All public methods are `async`; they never block the runtime.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout as tokio_timeout;

/// Default per-command timeout if none is supplied via [`ShellExecutor::with_timeout`].
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Captured outcome of a single shell invocation.
#[derive(Debug, Clone)]
pub struct ShellOutput {
    /// Decoded stdout (UTF-8, trailing whitespace preserved).
    pub stdout: String,
    /// Decoded stderr (UTF-8, trailing whitespace preserved).
    pub stderr: String,
    /// Process exit code (`-1` if the process was killed by a signal).
    pub exit_code: i32,
    /// Wall-clock time spent waiting for the child to exit.
    pub duration: Duration,
}

impl ShellOutput {
    /// Returns `true` iff the child exited with status 0.
    pub fn is_success(&self) -> bool {
        self.exit_code == 0
    }

    /// Returns `stdout` with leading/trailing whitespace trimmed — handy because
    /// most `gh` JSON outputs end with a stray newline.
    pub fn stdout_trimmed(&self) -> &str {
        self.stdout.trim()
    }
}

/// Errors that can be returned from [`ShellExecutor`].
#[derive(Debug, Error)]
pub enum ShellError {
    /// The child exited with a non-zero status. Carries the merged stderr/stdout
    /// for surfacing to the user.
    #[error("`{program}` failed (exit {exit_code}): {output}")]
    CommandFailed {
        /// Program name as passed to `run` / `run_with_stdin`.
        program: String,
        /// Process exit code.
        exit_code: i32,
        /// Truncated stderr (or stdout if stderr was empty).
        output: String,
    },

    /// The child was not on `$PATH` (or any of the augmented paths).
    #[error("command not found: {0}")]
    CommandNotFound(String),

    /// The child did not exit before the configured timeout elapsed and was killed.
    #[error("`{program}` timed out after {duration:?}")]
    Timeout {
        /// Program name as passed to `run` / `run_with_stdin`.
        program: String,
        /// The timeout that was exceeded.
        duration: Duration,
    },

    /// Something else went wrong (I/O, stdin pipe, UTF-8 decode).
    #[error("shell I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result alias used by every executor method.
pub type ShellResult<T> = Result<T, ShellError>;

/// Async wrapper around [`tokio::process::Command`] with PATH augmentation
/// matching the original Swift `ShellExecutor` so binaries installed via
/// Homebrew / npm / nix (commonly missing from a GUI-launched `$PATH`) are
/// reliably found.
#[derive(Debug, Clone)]
pub struct ShellExecutor {
    extra_path: Vec<PathBuf>,
    default_timeout: Duration,
    working_dir: Option<PathBuf>,
}

impl Default for ShellExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellExecutor {
    /// Build an executor with the standard PRMaster PATH augmentation list:
    /// `/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`, `/opt/local/{bin,sbin}`,
    /// `~/.local/bin`, `~/bin`, `~/.nix-profile/bin`, `~/.npm-global/bin`,
    /// `~/.claude/local`.
    pub fn new() -> Self {
        Self {
            extra_path: default_extra_path(),
            default_timeout: DEFAULT_TIMEOUT,
            working_dir: None,
        }
    }

    /// Build an executor with no extra PATH entries (`$PATH` is left untouched).
    pub fn bare() -> Self {
        Self {
            extra_path: Vec::new(),
            default_timeout: DEFAULT_TIMEOUT,
            working_dir: None,
        }
    }

    /// Override the default timeout (consumes and returns `self` so this is
    /// chainable on construction).
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.default_timeout = timeout;
        self
    }

    /// Append an extra entry to `$PATH`.
    #[must_use]
    pub fn with_path<P: Into<PathBuf>>(mut self, path: P) -> Self {
        self.extra_path.push(path.into());
        self
    }

    /// Pin a working directory used for every invocation unless overridden by
    /// [`run_in_dir`](Self::run_in_dir).
    #[must_use]
    pub fn with_working_dir<P: Into<PathBuf>>(mut self, dir: P) -> Self {
        self.working_dir = Some(dir.into());
        self
    }

    /// Run `program args…`, capturing stdout + stderr.
    pub async fn run(&self, program: &str, args: &[&str]) -> ShellResult<ShellOutput> {
        self.exec(program, args, None, self.working_dir.as_deref())
            .await
    }

    /// Run `program args…` with `stdin` piped in (used for `claude -p`).
    pub async fn run_with_stdin(
        &self,
        program: &str,
        args: &[&str],
        stdin: &str,
    ) -> ShellResult<ShellOutput> {
        self.exec(program, args, Some(stdin), self.working_dir.as_deref())
            .await
    }

    /// Run `program args…` with the working directory overridden.
    pub async fn run_in_dir(
        &self,
        dir: &Path,
        program: &str,
        args: &[&str],
    ) -> ShellResult<ShellOutput> {
        self.exec(program, args, None, Some(dir)).await
    }

    async fn exec(
        &self,
        program: &str,
        args: &[&str],
        stdin: Option<&str>,
        working_dir: Option<&Path>,
    ) -> ShellResult<ShellOutput> {
        let started = Instant::now();
        let augmented_path = self.augmented_path();

        let mut cmd = Command::new(program);
        cmd.args(args)
            .env("PATH", &augmented_path)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(dir) = working_dir {
            cmd.current_dir(dir);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ShellError::CommandNotFound(program.to_string()));
            }
            Err(e) => return Err(ShellError::Io(e)),
        };

        if let (Some(payload), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(payload.as_bytes()).await?;
            pipe.shutdown().await?;
        }

        let output = match tokio_timeout(self.default_timeout, child.wait_with_output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(ShellError::Io(e)),
            Err(_) => {
                // child handle was moved into wait_with_output(); just bail.
                tracing::warn!(program, "shell command timed out");
                return Err(ShellError::Timeout {
                    program: program.to_string(),
                    duration: self.default_timeout,
                });
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let exit_code = output.status.code().unwrap_or(-1);
        let duration = started.elapsed();

        if !output.status.success() {
            let merged = if !stderr.trim().is_empty() {
                stderr.clone()
            } else {
                stdout.clone()
            };
            let truncated = merged.chars().take(800).collect::<String>();
            return Err(ShellError::CommandFailed {
                program: program.to_string(),
                exit_code,
                output: truncated,
            });
        }

        Ok(ShellOutput {
            stdout,
            stderr,
            exit_code,
            duration,
        })
    }

    fn augmented_path(&self) -> String {
        let current = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        let mut parts: Vec<String> = self
            .extra_path
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        parts.push(current);
        parts.join(":")
    }
}

/// Returns the default extra-PATH list — matches the original Swift
/// `ShellExecutor.execute` augmentation so binaries installed via Homebrew /
/// MacPorts / npm / nix / Claude Code are discoverable from a GUI-launched
/// Tauri app on macOS.
fn default_extra_path() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/opt/local/sbin"),
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".nix-profile/bin"),
        home.join(".npm-global/bin"),
        home.join(".claude/local"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echoes_stdout() {
        let exec = ShellExecutor::new();
        let out = exec.run("echo", &["hello"]).await.expect("echo runs");
        assert!(out.is_success());
        assert_eq!(out.stdout_trimmed(), "hello");
    }

    #[tokio::test]
    async fn pipes_stdin() {
        let exec = ShellExecutor::new();
        let out = exec
            .run_with_stdin("cat", &[], "piped-payload")
            .await
            .expect("cat runs");
        assert_eq!(out.stdout_trimmed(), "piped-payload");
    }

    #[tokio::test]
    async fn maps_command_not_found() {
        let exec = ShellExecutor::bare().with_path("/nonexistent");
        let err = exec
            .run("definitely_not_a_real_program_zen_test", &[])
            .await
            .expect_err("should fail");
        assert!(matches!(err, ShellError::CommandNotFound(_)));
    }

    #[tokio::test]
    async fn surfaces_nonzero_exit() {
        let exec = ShellExecutor::new();
        let err = exec
            .run("sh", &["-c", "echo boom 1>&2; exit 7"])
            .await
            .expect_err("non-zero exit");
        match err {
            ShellError::CommandFailed { exit_code, .. } => assert_eq!(exit_code, 7),
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn enforces_timeout() {
        let exec = ShellExecutor::new().with_timeout(Duration::from_millis(150));
        let err = exec
            .run("sh", &["-c", "sleep 5"])
            .await
            .expect_err("should time out");
        assert!(matches!(err, ShellError::Timeout { .. }));
    }
}
