//! Tauri command surface for the **AI Review** tab on the PR Master
//! review page.
//!
//! Six commands plus one stream of `prmaster:ai-review:event` Tauri
//! events drive the whole tab:
//!
//! * `prmaster_ai_review_start` — resolve the local clone, prepare a
//!   detached worktree at the PR head SHA, register a run, and spawn
//!   Claude. Returns immediately so the UI can flip to the running
//!   view; per-event progress arrives via the event channel below.
//! * `prmaster_ai_review_status` — return the buffered event log + run
//!   metadata, used by the frontend to re-attach to a running review
//!   after a tab unmount or hot-reload.
//! * `prmaster_ai_review_cancel` — fire the cancel notify; the runner
//!   sends SIGTERM to its child and emits an Error event.
//! * `prmaster_ai_review_get_report` — read the persisted HTML +
//!   parsed findings for a `run_id` (from the SQLite index, so this
//!   keeps working across app restarts).
//! * `prmaster_ai_review_list_runs` — return the per-PR index used to
//!   render the cached "previous review" view on tab open.
//! * `prmaster_ai_review_post_finding` — bridge a finding id to the
//!   existing `add_review_comment` engine method so the user can post
//!   the suggestion as a real GitHub inline comment.
//!
//! `prmaster_ai_review_cleanup_merged` is hooked into the existing
//! `prmaster:refreshed` broadcast so reviews for merged-or-no-longer-
//! visible PRs are dropped automatically.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};

use zen_github::PrRef;
use zen_pr_review::{
    AiReviewEvent, Finding, PrKey, RunStatus, RunSummary, StartInputs,
};
use zen_prmaster::PrMasterSettings;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::user_config::UserConfig;

/// Storage key the PR Master settings live under (matches
/// `commands::prmaster::PRMASTER_SETTINGS_KEY`). Duplicated here to
/// avoid a circular re-export; if the prmaster module ever exposes a
/// public constant we should switch over.
const PRMASTER_SETTINGS_KEY: &str = "prmaster";

/// Tauri-event channel name. The frontend subscribes once at app
/// startup and demuxes by `run_id`.
const AI_REVIEW_EVENT: &str = "prmaster:ai-review:event";

/// Resolve `<app_data>/prmaster/ai-review/`. Created on demand.
/// Always under `app_data` — only the **worktree** location is
/// user-configurable; persisted reports stay with `user_config.db`
/// so they survive across moves of the worktree dir.
fn ai_review_root(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("resolve app_data_dir: {e}")))?;
    let root = dir.join("prmaster").join("ai-review");
    std::fs::create_dir_all(&root)?;
    std::fs::create_dir_all(root.join("worktrees"))?;
    std::fs::create_dir_all(root.join("reports"))?;
    Ok(root)
}

/// Resolve the directory that holds per-PR detached worktrees.
///
/// * Empty / unset settings → `<app_data>/prmaster/ai-review/worktrees/`.
/// * Non-empty `ai_review_worktrees_dir` → `<that path>/zen-tools-ai-review/`.
///
/// We always nest under our own subdir so a user pointing this at
/// `~/dev` doesn't end up with `~/dev/<owner>__<repo>__…/` directly
/// littered alongside their projects. The subdir name is stable so
/// users can find / clean it manually.
fn resolve_worktrees_root(app: &AppHandle, settings: &PrMasterSettings) -> AppResult<PathBuf> {
    let configured = settings
        .ai_review_worktrees_dir
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let root = match configured {
        Some(path) => PathBuf::from(path).join("zen-tools-ai-review"),
        None => ai_review_root(app)?.join("worktrees"),
    };
    std::fs::create_dir_all(&root)
        .map_err(|e| AppError::Other(format!(
            "create worktrees dir {}: {e}",
            root.display()
        )))?;
    Ok(root)
}

/// Convert a `PrRef` (`u64` number) to the in-crate `PrKey`.
fn pr_key(pr: &PrRef) -> PrKey {
    PrKey {
        owner: pr.owner.clone(),
        repo: pr.repo.clone(),
        number: pr.number,
    }
}

/// Lookup the local clone path for `(owner, repo)` from PR Master's
/// settings. Returns a structured error the frontend can branch on so
/// the user gets a deep-link to Settings → Repo Mappings instead of a
/// generic failure.
fn local_repo_path(settings: &PrMasterSettings, pr: &PrKey) -> AppResult<PathBuf> {
    let key = format!("{}/{}", pr.owner, pr.repo);
    let mapping = settings
        .repo_mappings
        .iter()
        .find(|m| m.repo == key)
        .ok_or_else(|| AppError::BadRequest(format!(
            "Local clone not registered for {key}. Add it under PR Master → Settings → Repo Mappings."
        )))?;
    let path = PathBuf::from(&mapping.local_path);
    if !path.exists() {
        return Err(AppError::BadRequest(format!(
            "Configured local clone for {key} does not exist on disk: {}",
            mapping.local_path
        )));
    }
    Ok(path)
}

/// Wire shape returned to the frontend after a successful start.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiReviewStartResp {
    /// Stable run id (UUID v4 string).
    pub run_id: String,
    /// Detached worktree path Claude is running inside.
    pub worktree_path: String,
    /// Echo of the head SHA the worktree was pinned to.
    pub head_sha: String,
}

/// Wire shape for the live status of a run. Sent back when the
/// frontend re-mounts mid-run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiReviewStatusResp {
    /// Current registry status (`starting | running | done | error | cancelled`).
    pub status: RunStatus,
    /// Buffered events in arrival order.
    pub events: Vec<AiReviewEvent>,
    /// Persisted report path when the run is `done`.
    pub report_path: Option<String>,
    /// PR identity.
    pub pr: PrKey,
    /// Head SHA reviewed.
    pub head_sha: String,
    /// Resolved Claude model.
    pub model: String,
    /// UNIX millis when the run started.
    pub started_at_ms: i64,
    /// UNIX millis when the run finished (`None` while live).
    pub finished_at_ms: Option<i64>,
    /// Cost in USD when the CLI reported one.
    pub cost_usd: Option<f64>,
}

/// Wire shape returned by `prmaster_ai_review_get_report`. Drives the
/// React-native renderer (no iframe — `html` is `None` for runs
/// produced by the current prompt; older runs may still carry one).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiReviewReportResp {
    /// Legacy self-contained HTML report (older runs only). The React
    /// renderer drives off `findings` directly; this field exists so
    /// the user can fall back to the original document if the render
    /// hits something unexpected.
    pub html: Option<String>,
    /// Parsed findings — primary input for the renderer.
    pub findings: Vec<Finding>,
    /// Streaming events captured while the run was live (for the
    /// History panel's "Log" action). Empty for runs that errored
    /// before they buffered anything, or for older records persisted
    /// before this field existed.
    pub events: Vec<AiReviewEvent>,
    /// One-sentence verdict copied from `report.json`'s `summary`.
    pub overall_summary: String,
    /// The exact prompt the run sent to `claude -p`. Surfaced via the
    /// "View prompt" disclosure so the user can audit what the model
    /// was asked to do.
    pub prompt: String,
    /// PR identity (echoed for the frontend's sanity check).
    pub pr: PrKey,
    /// Head SHA the report was generated against.
    pub head_sha: String,
    /// Resolved Claude model.
    pub model: String,
    /// Reported cost in USD when available.
    pub cost_usd: Option<f64>,
    /// UNIX millis when the run finished.
    pub finished_at_ms: Option<i64>,
}

/// Spawn a new AI review for `pr` at `head_sha`. Returns immediately;
/// progress is delivered through the `prmaster:ai-review:event` Tauri
/// event channel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn prmaster_ai_review_start(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    pr: PrRef,
    head_sha: String,
    head_branch: Option<String>,
    base_branch: Option<String>,
    model: Option<String>,
) -> AppResult<AiReviewStartResp> {
    let settings = config
        .get::<PrMasterSettings>(PRMASTER_SETTINGS_KEY)?
        .unwrap_or_default();
    if settings.ai_provider != "claude" {
        return Err(AppError::BadRequest(format!(
            "AI Review only supports Claude for v1 (current provider: {:?}). Switch under PR Master → Settings.",
            settings.ai_provider
        )));
    }
    let pr_key = pr_key(&pr);
    let local_repo = local_repo_path(&settings, &pr_key)?;
    // Reports always live under app_data so the user can move the
    // worktrees dir without losing their persisted history.
    let app_root = ai_review_root(&app)?;
    let worktrees_root = resolve_worktrees_root(&app, &settings)?;
    let review = state.lock().await.review.clone();

    let model_for_run = model
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| Some(settings.ai_model.clone()).filter(|s| !s.is_empty()));

    let inputs = StartInputs {
        pr: pr_key.clone(),
        head_sha: head_sha.clone(),
        head_branch: head_branch.clone(),
        base_branch: base_branch.clone(),
        model: model_for_run.clone(),
        local_repo: &local_repo,
        worktrees_root: &worktrees_root,
    };
    let handles = review.start(inputs).await?;

    // Build the prompt now that we have the worktree path. We don't
    // pass a `base_sha` because the frontend doesn't currently know it
    // — the prompt template instructs Claude to derive it itself via
    // `git merge-base origin/<base_branch> HEAD` inside the worktree.
    let prompt_text = zen_pr_review::prompt::build_review_prompt(
        None,
        head_sha.as_str(),
        head_branch.as_deref(),
        base_branch.as_deref(),
        None,
        &handles.worktree_path.to_string_lossy(),
    );

    // Spin up the channel that bridges `ReviewEngine::run` events into
    // Tauri events. The receiver task lives until the sender drops at
    // end of the run.
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, AiReviewEvent)>();
    {
        let app = app.clone();
        tokio::spawn(async move {
            while let Some((run_id, event)) = rx.recv().await {
                #[derive(Serialize)]
                struct Payload<'a> {
                    run_id: &'a str,
                    #[serde(flatten)]
                    event: &'a AiReviewEvent,
                    ts_ms: i64,
                }
                let payload = Payload {
                    run_id: &run_id,
                    event: &event,
                    ts_ms: chrono::Utc::now().timestamp_millis(),
                };
                if let Err(e) = app.emit(AI_REVIEW_EVENT, &payload) {
                    tracing::warn!(?e, "ai-review: emit event failed");
                }
            }
        });
    }

    // Spawn the actual run on its own task so the command returns ASAP.
    {
        let review = review.clone();
        let kv = config.inner().clone();
        let run_id = handles.run_id.clone();
        let worktree_path = handles.worktree_path.clone();
        let local_repo_for_run = local_repo.clone();
        let reports_root = app_root.join("reports");
        let cancel = handles.cancel.clone();
        tokio::spawn(async move {
            let res = review
                .run(
                    &run_id,
                    worktree_path,
                    local_repo_for_run,
                    reports_root,
                    kv,
                    prompt_text,
                    model_for_run,
                    cancel,
                    tx,
                )
                .await;
            if let Err(e) = res {
                tracing::warn!(error = %e, run_id, "ai-review: run terminated with error");
            }
        });
    }

    Ok(AiReviewStartResp {
        run_id: handles.run_id,
        worktree_path: handles.worktree_path.to_string_lossy().into_owned(),
        head_sha: handles.head_sha,
    })
}

/// Snapshot the live registry for `run_id`. Used by the frontend on
/// re-mount to replay events that were already delivered.
#[tauri::command]
pub async fn prmaster_ai_review_status(
    state: State<'_, Mutex<AppState>>,
    run_id: String,
) -> AppResult<Option<AiReviewStatusResp>> {
    let review = state.lock().await.review.clone();
    let snap = match review.status(&run_id) {
        Some(s) => s,
        None => return Ok(None),
    };
    Ok(Some(AiReviewStatusResp {
        status: snap.status,
        events: snap.events,
        report_path: snap.report_path,
        pr: snap.pr,
        head_sha: snap.head_sha,
        model: snap.model,
        started_at_ms: snap.started_at_ms,
        finished_at_ms: snap.finished_at_ms,
        cost_usd: snap.cost_usd,
    }))
}

/// Cancel a running review.
#[tauri::command]
pub async fn prmaster_ai_review_cancel(
    state: State<'_, Mutex<AppState>>,
    run_id: String,
) -> AppResult<bool> {
    let review = state.lock().await.review.clone();
    Ok(review.cancel(&run_id))
}

/// Read the persisted findings + metadata for a completed run. The
/// React renderer drives the UI from this; the legacy HTML (if any)
/// is returned alongside for fall-back inspection.
#[tauri::command]
pub async fn prmaster_ai_review_get_report(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    run_id: String,
) -> AppResult<AiReviewReportResp> {
    let review = state.lock().await.review.clone();
    let kv = config.inner().clone();
    let record = review
        .get_record(&kv, &run_id)?
        .ok_or_else(|| AppError::BadRequest(format!("unknown run_id: {run_id}")))?;
    // Older runs persisted an HTML body; current ones don't. We read
    // the file lazily and ignore IO errors — the React renderer is
    // the authoritative view, the HTML is just a debugging aid.
    let html = record
        .report_html_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    Ok(AiReviewReportResp {
        html,
        findings: record.findings,
        events: record.events,
        overall_summary: record.overall_summary,
        prompt: record.prompt,
        head_sha: record.summary.head_sha.clone(),
        model: record.summary.model.clone(),
        cost_usd: record.summary.cost_usd,
        finished_at_ms: record.summary.finished_at_ms,
        pr: record.pr,
    })
}

/// Per-PR run history, newest-first. Drives the "previous review"
/// fast-path on tab open.
#[tauri::command]
pub async fn prmaster_ai_review_list_runs(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    pr: PrRef,
) -> AppResult<Vec<RunSummary>> {
    let review = state.lock().await.review.clone();
    let kv = config.inner().clone();
    Ok(review.list_runs(&kv, &pr_key(&pr))?)
}

/// Return the **default formatted body** for a finding, exactly as it
/// would be posted if the user clicked Post without editing. Drives
/// the inline "Edit before post" textarea: the frontend pre-fills
/// the editor with this string and sends back whatever the user
/// finally chose. Pure read-only — never touches GitHub.
#[tauri::command]
pub async fn prmaster_ai_review_preview_finding_body(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    run_id: String,
    finding_id: String,
) -> AppResult<String> {
    let review = state.lock().await.review.clone();
    let kv = config.inner().clone();
    let finding = review.find_finding(&kv, &run_id, &finding_id)?;
    Ok(format_finding_body(&finding))
}

/// Post a finding as a real GitHub inline review comment via the
/// existing prmaster engine path.
///
/// **Posting policy (read carefully if you're modifying this code):**
///
/// 1. **Never mention AI / automation in the body.** The comment we
///    POST must read as if a human reviewer wrote it — no `[AI review]`
///    prefix, no model names, no "generated by", no boilerplate
///    disclaimers. The user is taking responsibility for the comment
///    by clicking Post; the comment carries their authorship on
///    GitHub. Anything that flags this as an AI artefact undermines
///    that trust contract and pollutes the PR's reviewability.
///
/// 2. **Explicit user action only — never auto-post.** This command
///    is the *only* code path in the entire app that calls
///    `engine.add_review_comment` for a finding, and it is invoked
///    exclusively from the per-finding "Post inline comment" button
///    on `AiReviewFindingCard` — and only after the user clicks Post
///    in the inline editor (see [`prmaster_ai_review_preview_finding_body`]).
///    There is no batch / "post all" flow, no "auto-post critical
///    findings" toggle, no `prmaster:ai-review:event` handler that
///    posts on its own. Adding any of those would be a policy
///    change requiring an explicit decision — do **not** add one in
///    passing.
///
/// 3. **The frontend is the source of truth for the body.** This
///    command takes the body verbatim from the UI; users are free
///    to edit, append, rewrite, or replace anything they want before
///    clicking Post. We trim trailing whitespace and reject empty
///    bodies but otherwise post exactly what the user typed.
///
/// If a future change needs to post programmatically (e.g. a CI
/// integration), it should live behind a separate Tauri command
/// with a name that reflects the policy delta, not extend this one.
#[tauri::command]
pub async fn prmaster_ai_review_post_finding(
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    run_id: String,
    finding_id: String,
    body: String,
) -> AppResult<()> {
    let body_trimmed = body.trim();
    if body_trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "comment body cannot be empty".into(),
        ));
    }
    let (review, prmaster) = {
        let s = state.lock().await;
        (s.review.clone(), s.prmaster.clone())
    };
    let kv = config.inner().clone();
    let record = review
        .get_record(&kv, &run_id)?
        .ok_or_else(|| AppError::BadRequest(format!("unknown run_id: {run_id}")))?;
    let finding = record
        .findings
        .iter()
        .find(|f| f.id == finding_id)
        .ok_or_else(|| AppError::BadRequest(format!("unknown finding_id: {finding_id}")))?
        .clone();
    let pr_ref = PrRef {
        owner: record.pr.owner.clone(),
        repo: record.pr.repo.clone(),
        number: record.pr.number,
    };
    let side = match finding.side.as_str() {
        "LEFT" => zen_github::DiffSide::Left,
        _ => zen_github::DiffSide::Right,
    };
    prmaster
        .add_review_comment(
            &pr_ref,
            body_trimmed,
            &record.summary.head_sha,
            &finding.path,
            finding.end_line,
            side,
        )
        .await?;
    Ok(())
}

/// Format a finding into the markdown body posted as an inline review
/// comment.
///
/// **Body content rules** (paired with the policy doc on
/// [`prmaster_ai_review_post_finding`]):
///
/// * No `[AI review]` / `[Bot]` / `Generated by …` prefix.
/// * No model name, severity tag, or finding id in the body.
/// * No automation disclaimer at the top or bottom.
/// * The comment reads as if a human reviewer wrote it: a one-line
///   "what's wrong" followed by the rationale, with an optional
///   GitHub-flavoured suggestion block when a concrete replacement
///   is available.
///
/// We use GitHub's [suggested-change syntax]
/// (a fenced block tagged `suggestion`) when `suggested` looks like a
/// drop-in replacement, so the reviewee can apply it with one click
/// from the GitHub UI. Otherwise we fall back to a plain fenced code
/// block. The literal "(remove these lines)" sentinel from the prompt
/// is mapped to an explicit deletion suggestion (an empty
/// `suggestion` block).
///
/// [suggested-change syntax]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request
fn format_finding_body(f: &Finding) -> String {
    let mut out = String::new();
    if !f.title.is_empty() {
        out.push_str(&f.title);
        out.push('\n');
        out.push('\n');
    }
    if !f.rationale.is_empty() {
        out.push_str(f.rationale.trim());
        out.push('\n');
    }
    let suggested = f.suggested.trim();
    if !suggested.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        let lower = suggested.to_ascii_lowercase();
        if lower == "(remove these lines)" || lower == "(remove)" || lower == "(delete)" {
            // GitHub's suggestion block with no content = "remove this".
            out.push_str("```suggestion\n```\n");
        } else {
            out.push_str("```suggestion\n");
            out.push_str(suggested.trim_end_matches('\n'));
            out.push('\n');
            out.push_str("```\n");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use zen_pr_review::Finding;

    fn finding(severity: &str, suggested: &str) -> Finding {
        Finding {
            id: "fid-1".into(),
            severity: severity.into(),
            title: "Stray invalid text breaks CSS parsing".into(),
            path: "frontend/styles.css".into(),
            start_line: 9,
            end_line: 9,
            side: "RIGHT".into(),
            snippet_start_line: Some(6),
            current: "asdfasdfasdfasdf\n".into(),
            language: "css".into(),
            suggested: suggested.into(),
            rationale: "The token is not valid CSS and will abort parsing.".into(),
        }
    }

    #[test]
    fn body_never_mentions_ai_or_automation() {
        // Pin the policy: posted comments must read as human review
        // notes. Any leak of "AI" / "Claude" / "model" / "generated"
        // is a regression.
        let cases = [
            finding("critical", ""),
            finding("high", "color: red;"),
            finding("medium", "(remove these lines)"),
        ];
        for f in cases {
            let body = format_finding_body(&f);
            let lower = body.to_ascii_lowercase();
            for forbidden in [
                "ai review", "ai-review", "[ai", "claude", "anthropic",
                "automated", "generated by", "model:", "bot ", "[bot]",
            ] {
                assert!(
                    !lower.contains(forbidden),
                    "comment body must not mention {forbidden:?}; got {body:?}"
                );
            }
            // Severity should not surface either — the user reads
            // severity in the app UI before clicking Post; the
            // posted comment shouldn't carry it.
            for sev in ["critical", "high", "medium", "low"] {
                let tag = format!("[{sev}");
                assert!(
                    !lower.contains(&tag),
                    "comment body must not contain {tag:?}; got {body:?}"
                );
            }
        }
    }

    #[test]
    fn remove_sentinel_emits_empty_suggestion_block() {
        let body = format_finding_body(&finding("high", "(remove these lines)"));
        assert!(body.contains("```suggestion\n```"));
    }

    #[test]
    fn concrete_replacement_uses_suggestion_block() {
        let body = format_finding_body(&finding("high", "color: red;"));
        assert!(body.contains("```suggestion\ncolor: red;\n```"));
    }

    #[test]
    fn empty_suggestion_omits_block() {
        let body = format_finding_body(&finding("medium", ""));
        assert!(!body.contains("```suggestion"));
        assert!(!body.contains("```"));
    }
}

/// Reveal `<app_data>/prmaster/ai-review/reports/` in the OS file
/// manager (Finder on macOS). Surfaced from the global Settings page
/// so users can poke at the persisted reports / findings JSON
/// directly when they want to.
#[tauri::command]
pub async fn prmaster_ai_review_open_reports_dir(app: AppHandle) -> AppResult<()> {
    let root = ai_review_root(&app)?;
    let reports = root.join("reports");
    std::fs::create_dir_all(&reports)?;
    crate::dictation::commands::open_path_in_finder(&reports).await
}

/// Drop everything we know about every PR not in `visible_slugs`.
/// Wired to the `prmaster:refreshed` broadcast so a merged or
/// no-longer-visible PR's review artefacts purge automatically.
#[tauri::command]
pub async fn prmaster_ai_review_cleanup_merged(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    config: State<'_, UserConfig>,
    visible_slugs: Vec<String>,
) -> AppResult<u32> {
    let review = state.lock().await.review.clone();
    let kv = config.inner().clone();
    let root = ai_review_root(&app)?;
    let reports_root = root.join("reports");
    let purged = review.cleanup_for_visible(&kv, &reports_root, &visible_slugs)?;
    if purged > 0 {
        tracing::info!(purged, "ai-review: purged review artefacts for closed/merged PRs");
    }
    Ok(purged)
}

