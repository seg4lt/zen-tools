//! AI-driven PR code review orchestration.
//!
//! Public surface:
//!
//! * [`ReviewEngine`] — the cheap-to-clone (`Arc`-backed) controller
//!   the Tauri layer holds. Owns the in-memory [`state::RunRegistry`]
//!   and resolves the on-disk paths used for worktrees / reports.
//! * The four async entry points the Tauri commands wrap:
//!   [`ReviewEngine::start`], [`ReviewEngine::cancel`],
//!   [`ReviewEngine::status`], and [`ReviewEngine::cleanup_for_visible`].
//!
//! Storage layout, under `<app_data>/prmaster/ai-review/`:
//!
//! ```text
//! worktrees/<owner>__<repo>__<number>__<short_sha>/   ← detached worktree
//! reports/<run_id>.html                               ← persisted HTML
//! reports/<run_id>.json                               ← findings JSON
//! ```

#![warn(missing_docs)]

pub mod error;
pub mod events;
pub mod persist;
pub mod prompt;
pub mod runner;
pub mod state;
pub mod worktree;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::mpsc;
use zen_storage::KvStore;

pub use crate::error::{ReviewError, ReviewResult};
pub use crate::events::AiReviewEvent;
pub use crate::persist::{Finding, ReportPayload, RunRecord, RunSummary};
pub use crate::runner::{spawn_claude, EventSink, RunOutcome, MAX_RUN_SECS};
pub use crate::state::{PrKey, RunEntry, RunRegistry, RunStatus};

/// Cheap-to-clone (`Arc`-backed) review controller. Holds the in-memory
/// run registry; the SQLite store and reports root are passed in per
/// call so the Tauri layer can manage their lifetimes alongside the
/// rest of `UserConfig`.
#[derive(Debug, Clone, Default)]
pub struct ReviewEngine {
    inner: Arc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    registry: RunRegistry,
}

/// Inputs the Tauri layer hands to [`ReviewEngine::start`].
#[derive(Debug, Clone)]
pub struct StartInputs<'a> {
    /// PR identity.
    pub pr: PrKey,
    /// Head SHA we're reviewing.
    pub head_sha: String,
    /// Head branch name (for `git fetch`); optional but recommended.
    pub head_branch: Option<String>,
    /// Base branch name (for `git fetch`); optional but recommended.
    pub base_branch: Option<String>,
    /// Resolved Claude model (e.g. `"sonnet"`).
    pub model: Option<String>,
    /// Local clone of `<owner>/<repo>` we'll create the worktree from.
    pub local_repo: &'a Path,
    /// Directory the per-PR detached worktree gets created inside.
    /// The Tauri layer resolves this from the user's settings (with a
    /// fallback to `<app_data>/prmaster/ai-review/worktrees/`); we
    /// take it as an explicit input so the engine never has to know
    /// about the user-config plumbing. Each worktree is created at
    /// `<worktrees_root>/<owner>__<repo>__<number>__<short_sha>/`.
    pub worktrees_root: &'a Path,
}

/// Result of a successful start — what the Tauri command returns to
/// the frontend so it can render the running view immediately.
#[derive(Debug, Clone)]
pub struct StartHandles {
    /// Stable run id (UUID v4 string).
    pub run_id: String,
    /// Detached worktree path Claude is running inside.
    pub worktree_path: PathBuf,
    /// Echo of the head SHA we pinned the worktree to.
    pub head_sha: String,
    /// Cancel notifier — handed back so the caller can drive
    /// [`ReviewEngine::run`] (cancellation is also reachable via
    /// [`ReviewEngine::cancel`] from a later command call).
    pub cancel: Arc<tokio::sync::Notify>,
}

impl ReviewEngine {
    /// Build a fresh engine with an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Borrow the in-memory registry — used by the Tauri layer when it
    /// needs to look up a snapshot for `prmaster_ai_review_status`.
    pub fn registry(&self) -> &RunRegistry {
        &self.inner.registry
    }

    /// Prepare the worktree, register the run, and return immediately
    /// with the handles the frontend needs. The caller is responsible
    /// for spawning [`Self::run`] on a tokio task with the same
    /// `run_id`.
    pub async fn start(&self, inputs: StartInputs<'_>) -> ReviewResult<StartHandles> {
        std::fs::create_dir_all(inputs.worktrees_root)?;

        let target = worktree::worktree_path(
            inputs.worktrees_root,
            &inputs.pr.owner,
            &inputs.pr.repo,
            inputs.pr.number,
            &inputs.head_sha,
        );

        let exec = worktree::build_git_executor();
        worktree::prepare_worktree(
            &exec,
            inputs.local_repo,
            inputs.head_branch.as_deref(),
            inputs.base_branch.as_deref(),
            &inputs.head_sha,
            &target,
        )
        .await?;

        let model = inputs
            .model
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "sonnet".to_string());

        let (run_id, cancel) = self
            .inner
            .registry
            .start(
                inputs.pr.clone(),
                inputs.head_sha.clone(),
                target.to_string_lossy().into_owned(),
                model,
            )
            .map_err(|_| ReviewError::AlreadyRunning)?;
        Ok(StartHandles {
            run_id,
            worktree_path: target,
            head_sha: inputs.head_sha.clone(),
            cancel,
        })
    }

    /// Run the prepared review to completion. Events flow through
    /// `event_tx`: the Tauri layer subscribes and re-emits them as
    /// `prmaster:ai-review:event`. We also append to the in-memory
    /// registry so a re-mount can replay.
    ///
    /// On success this:
    /// 1. Reads `<worktree>/.zen-review/report.{html,json}`.
    /// 2. Copies them to `<reports_root>/<run_id>.{html,json}`.
    /// 3. Persists a [`RunRecord`] to `kv` and updates the per-PR index.
    /// 4. Best-effort `git worktree remove --force` on the temp worktree.
    /// 5. Sends a final [`AiReviewEvent::Done`] with the report path.
    #[allow(clippy::too_many_arguments)]
    pub async fn run(
        &self,
        run_id: &str,
        worktree_path: PathBuf,
        local_repo: PathBuf,
        reports_root: PathBuf,
        kv: KvStore,
        prompt_text: String,
        model: Option<String>,
        cancel: Arc<tokio::sync::Notify>,
        event_tx: mpsc::UnboundedSender<(String, AiReviewEvent)>,
    ) -> ReviewResult<()> {
        let run_id_owned = run_id.to_string();
        let registry = self.inner.registry.clone();
        // Keep a copy of the prompt for the persisted RunRecord so the
        // "View prompt" disclosure on the report view can show it.
        let prompt_text_for_record = prompt_text.clone();

        // Build a sink that fans events into both the registry and the
        // outbound mpsc channel. The mpsc sender is `Clone`, so we can
        // hand a copy to the runner without lifetime gymnastics.
        let tx_for_runner = event_tx.clone();
        let registry_for_runner = registry.clone();
        let run_id_for_runner = run_id_owned.clone();
        let runner_sink = move |event: AiReviewEvent| {
            registry_for_runner.append_event(&run_id_for_runner, event.clone());
            let _ = tx_for_runner.send((run_id_for_runner.clone(), event));
        };

        let outcome = runner::spawn_claude(
            worktree_path.clone(),
            prompt_text,
            model.clone(),
            cancel,
            runner_sink,
        )
        .await;

        // Helper closure that mirrors the runner's fan-out pattern for
        // post-run events (Done / Error emitted by us, not Claude).
        let emit = |event: AiReviewEvent| {
            registry.append_event(&run_id_owned, event.clone());
            let _ = event_tx.send((run_id_owned.clone(), event));
        };

        match outcome {
            Ok(out) if out.success => {
                let html_src = worktree_path.join(prompt::REPORT_HTML_REL);
                let json_src = worktree_path.join(prompt::REPORT_JSON_REL);
                let report_payload = match persist::parse_report_json(&json_src) {
                    Ok(p) => p,
                    Err(e) => {
                        emit(AiReviewEvent::Error {
                            message: format!("Failed to parse report.json: {e}"),
                        });
                        self.finalize(
                            run_id,
                            RunStatus::Error,
                            None,
                            None,
                            String::new(),
                            Vec::new(),
                            prompt_text_for_record.clone(),
                            Vec::new(),
                            out.cost_usd,
                            Some(out.duration_ms),
                            &reports_root,
                            &kv,
                            &local_repo,
                            &worktree_path,
                        )
                        .await;
                        return Err(e);
                    }
                };
                let (dst_html_opt, dst_json) = match persist::persist_report_files(
                    run_id,
                    &html_src,
                    &json_src,
                    &reports_root,
                ) {
                    Ok(paths) => paths,
                    Err(e) => {
                        emit(AiReviewEvent::Error {
                            message: format!("Failed to copy report files: {e}"),
                        });
                        self.finalize(
                            run_id,
                            RunStatus::Error,
                            None,
                            None,
                            String::new(),
                            Vec::new(),
                            String::new(),
                            Vec::new(),
                            out.cost_usd,
                            Some(out.duration_ms),
                            &reports_root,
                            &kv,
                            &local_repo,
                            &worktree_path,
                        )
                        .await;
                        return Err(e);
                    }
                };
                let findings_count = report_payload.findings.len() as u32;
                // Use the JSON path as the canonical "report path" the
                // frontend sees — the React renderer drives off it
                // directly. The HTML, when present, is purely a
                // legacy / debug artefact.
                let report_path = dst_json.to_string_lossy().into_owned();
                emit(AiReviewEvent::Done {
                    cost_usd: out.cost_usd,
                    duration_ms: out.duration_ms,
                    report_path: Some(report_path.clone()),
                    findings_count: Some(findings_count),
                });
                let html_path = dst_html_opt.map(|p| p.to_string_lossy().into_owned());
                self.finalize(
                    run_id,
                    RunStatus::Done,
                    html_path,
                    Some(report_path),
                    report_payload.summary.clone(),
                    report_payload.change_summary.clone(),
                    prompt_text_for_record.clone(),
                    report_payload.findings,
                    out.cost_usd,
                    Some(out.duration_ms),
                    &reports_root,
                    &kv,
                    &local_repo,
                    &worktree_path,
                )
                .await;
                Ok(())
            }
            Ok(out) => {
                emit(AiReviewEvent::Error {
                    message: format!(
                        "Claude exited non-zero. tail: {}",
                        out.stderr_tail.chars().take(400).collect::<String>()
                    ),
                });
                self.finalize(
                    run_id,
                    RunStatus::Error,
                    None,
                    None,
                    String::new(),
                    Vec::new(),
                    prompt_text_for_record.clone(),
                    Vec::new(),
                    out.cost_usd,
                    Some(out.duration_ms),
                    &reports_root,
                    &kv,
                    &local_repo,
                    &worktree_path,
                )
                .await;
                Err(ReviewError::Other("claude exited non-zero".into()))
            }
            Err(ReviewError::Cancelled) => {
                self.finalize(
                    run_id,
                    RunStatus::Cancelled,
                    None,
                    None,
                    String::new(),
                    Vec::new(),
                    prompt_text_for_record.clone(),
                    Vec::new(),
                    None,
                    None,
                    &reports_root,
                    &kv,
                    &local_repo,
                    &worktree_path,
                )
                .await;
                Err(ReviewError::Cancelled)
            }
            Err(e) => {
                self.finalize(
                    run_id,
                    RunStatus::Error,
                    None,
                    None,
                    String::new(),
                    Vec::new(),
                    prompt_text_for_record.clone(),
                    Vec::new(),
                    None,
                    None,
                    &reports_root,
                    &kv,
                    &local_repo,
                    &worktree_path,
                )
                .await;
                Err(e)
            }
        }
    }

    /// Snapshot a run for re-attach.
    pub fn status(&self, run_id: &str) -> Option<RunEntry> {
        self.inner.registry.snapshot(run_id)
    }

    /// Cancel a running review.
    pub fn cancel(&self, run_id: &str) -> bool {
        self.inner.registry.cancel(run_id)
    }

    /// Per-PR index for the AI Review tab's "do we already have a
    /// cached report for this head sha?" check.
    pub fn list_runs(&self, kv: &KvStore, pr: &PrKey) -> ReviewResult<Vec<RunSummary>> {
        persist::load_index(kv, pr)
    }

    /// Resolve a single run's record (with parsed findings).
    pub fn get_record(&self, kv: &KvStore, run_id: &str) -> ReviewResult<Option<RunRecord>> {
        persist::load_run(kv, run_id)
    }

    /// Read a finding from a persisted run by id.
    pub fn find_finding(
        &self,
        kv: &KvStore,
        run_id: &str,
        finding_id: &str,
    ) -> ReviewResult<Finding> {
        let record = persist::load_run(kv, run_id)?
            .ok_or_else(|| ReviewError::UnknownRun(run_id.to_string()))?;
        record
            .findings
            .into_iter()
            .find(|f| f.id == finding_id)
            .ok_or_else(|| ReviewError::UnknownFinding(finding_id.to_string()))
    }

    /// Drop everything we know about every PR not in `visible_slugs`
    /// (i.e. the ones the user can still see in the To Review / Done /
    /// Mine lists). Called from the `prmaster:refreshed` bridge so a
    /// merged-or-closed PR's review artefacts don't linger.
    pub fn cleanup_for_visible(
        &self,
        kv: &KvStore,
        reports_root: &Path,
        visible_slugs: &[String],
    ) -> ReviewResult<u32> {
        let visible: ahash::HashSet<&str> = visible_slugs.iter().map(|s| s.as_str()).collect();
        // Walk all keys with the `ai_review:index:` prefix. KvStore
        // doesn't expose a key iterator, so we go through the
        // underlying SQLite connection directly.
        let conn = kv.connection().clone();
        let prefix = "ai_review:index:";
        let mut keys: Vec<String> = Vec::new();
        {
            let conn = conn.lock();
            let mut stmt = conn
                .prepare("SELECT key FROM config WHERE key LIKE ?1")
                .map_err(|e| ReviewError::Other(format!("kv scan: {e}")))?;
            let rows = stmt
                .query_map(rusqlite::params![format!("{prefix}%")], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| ReviewError::Other(format!("kv scan: {e}")))?;
            for k in rows {
                keys.push(k.map_err(|e| ReviewError::Other(format!("kv scan: {e}")))?);
            }
        }
        let mut purged = 0u32;
        for key in keys {
            let slug = key.trim_start_matches(prefix).to_string();
            if visible.contains(slug.as_str()) {
                continue;
            }
            if let Some(pr) = parse_slug(&slug) {
                purged += persist::purge_pr(kv, &pr, reports_root)?;
            }
        }
        Ok(purged)
    }

    /// Internal helper: persist final state, copy reports if any, and
    /// remove the worktree. Errors here are logged but never propagated
    /// — the user has already seen the run finish.
    #[allow(clippy::too_many_arguments)]
    async fn finalize(
        &self,
        run_id: &str,
        status: RunStatus,
        report_html_path: Option<String>,
        report_json_path: Option<String>,
        overall_summary: String,
        change_summary: Vec<String>,
        prompt_text: String,
        findings: Vec<Finding>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        reports_root: &Path,
        kv: &KvStore,
        local_repo: &Path,
        worktree_path: &Path,
    ) {
        let entry = self.inner.registry.finish(
            run_id,
            status,
            report_html_path.clone(),
            cost_usd,
            duration_ms,
        );
        if let Some(entry) = entry {
            let summary = RunSummary {
                run_id: entry.run_id.clone(),
                head_sha: entry.head_sha.clone(),
                model: entry.model.clone(),
                started_at_ms: entry.started_at_ms,
                finished_at_ms: entry.finished_at_ms,
                status: entry.status,
                cost_usd: entry.cost_usd,
            };
            // Snapshot the buffered event log into the persisted
            // record so the History panel's "Log" action can replay
            // the streaming session even after the app has restarted.
            let events = entry.events.clone();
            let record = RunRecord {
                pr: entry.pr.clone(),
                summary,
                report_html_path,
                report_json_path,
                overall_summary,
                change_summary,
                prompt: prompt_text,
                findings,
                events,
            };
            if let Err(e) = persist::record_completion(kv, &entry.pr, &record, reports_root) {
                tracing::warn!(?e, "ai-review: persisting run record failed");
            }
        }
        // Worktree cleanup is best-effort.
        let exec = worktree::build_git_executor();
        if let Err(e) = worktree::remove_worktree(&exec, local_repo, worktree_path).await {
            tracing::warn!(?e, "ai-review: worktree cleanup failed");
        }
    }
}

/// Helper: turn `"owner/repo#42"` → `PrKey { owner, repo, number: 42 }`.
fn parse_slug(slug: &str) -> Option<PrKey> {
    let (owner_repo, number_str) = slug.rsplit_once('#')?;
    let (owner, repo) = owner_repo.split_once('/')?;
    let number: u64 = number_str.parse().ok()?;
    Some(PrKey {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slugs() {
        let pr = parse_slug("octo/demo#42").unwrap();
        assert_eq!(pr.owner, "octo");
        assert_eq!(pr.repo, "demo");
        assert_eq!(pr.number, 42);
        assert!(parse_slug("not-a-slug").is_none());
        assert!(parse_slug("octo/demo").is_none());
    }
}
