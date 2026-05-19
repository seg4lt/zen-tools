//! Persisted review history backed by [`zen_storage::KvStore`].
//!
//! Two key namespaces:
//!
//! * `ai_review:index:<owner>/<repo>#<number>` → newest-first list of
//!   [`RunSummary`]s, capped at [`MAX_RUNS_PER_PR`]. Used by the AI
//!   Review tab to decide whether to render a cached report on mount.
//! * `ai_review:run:<run_id>` → full [`RunRecord`] including the parsed
//!   findings JSON. Used to wire each "Post inline comment" button.
//!
//! The HTML / JSON files themselves live on disk under
//! `<reports_dir>/<run_id>.{html,json}` so the SQLite blobs stay tiny
//! and the iframe can lazily fetch through the existing
//! `read_file_content` Tauri command if we ever need that path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zen_storage::KvStore;

use crate::error::{ReviewError, ReviewResult};
use crate::events::AiReviewEvent;
use crate::state::{PrKey, RunStatus};

/// Maximum runs we keep in the per-PR index. Older entries are
/// discarded along with their on-disk artefacts.
pub const MAX_RUNS_PER_PR: usize = 10;

/// One row in the per-PR run index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    /// UUID v4 string.
    pub run_id: String,
    /// Head SHA the review targeted.
    pub head_sha: String,
    /// Resolved Claude model (e.g. `"sonnet"`).
    pub model: String,
    /// UNIX millis when the run started.
    pub started_at_ms: i64,
    /// UNIX millis when the run finished, or `None` while live.
    pub finished_at_ms: Option<i64>,
    /// Final status (`done` / `error` / `cancelled`).
    pub status: RunStatus,
    /// Reported cost in USD when available.
    pub cost_usd: Option<f64>,
}

/// Full record persisted alongside the index entry. Carries the parsed
/// findings list so the host can map a `finding_id` → inline comment
/// payload without re-reading `report.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    /// PR identity.
    pub pr: PrKey,
    /// The summary slice copied into the per-PR index.
    pub summary: RunSummary,
    /// Absolute path to the persisted HTML report on disk. Older runs
    /// produced one (the old prompt asked Claude for HTML); current
    /// runs leave this `None` and the React renderer drives off
    /// `findings` directly.
    pub report_html_path: Option<String>,
    /// Absolute path to the persisted findings JSON on disk.
    pub report_json_path: Option<String>,
    /// One-sentence overall verdict copied from `report.json`. Drives
    /// the header badge on the report view; empty for older records
    /// persisted before this field existed.
    #[serde(default)]
    pub overall_summary: String,
    /// High-level bullet summary of what changed in the PR. Copied
    /// from `report.json`'s `change_summary`; empty for older runs.
    #[serde(default)]
    pub change_summary: Vec<String>,
    /// The exact prompt text sent to `claude -p`. Surfaced via the
    /// "View prompt" disclosure on the report view so the user can
    /// audit what the model was asked to do.
    #[serde(default)]
    pub prompt: String,
    /// Parsed findings (mirror of `report.json`'s `findings` array).
    /// Empty when status != Done.
    pub findings: Vec<Finding>,
    /// Streaming events captured while the run was live (thoughts,
    /// tool calls, tool results, …). Persisted so the History panel's
    /// "Log" action on each row can replay the original session even
    /// after the app has restarted. Older records persisted before
    /// this field existed deserialise with an empty list.
    #[serde(default)]
    pub events: Vec<AiReviewEvent>,
}

/// One severity-tagged finding extracted from `report.json`.
///
/// The schema is stable across the wire — bumping it requires a
/// matching frontend update to `src/tools/prmaster/lib/tauri.ts`.
/// Forward compatibility is via `#[serde(default)]` everywhere except
/// the structural identity fields (`id`, `severity`, `path`, `title`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    /// Stable id matching the HTML's `data-finding-id`.
    pub id: String,
    /// Severity bucket.
    pub severity: String,
    /// Short title shown in the review UI.
    pub title: String,
    /// Path relative to the worktree root (i.e. repo-relative).
    pub path: String,
    /// 1-based start line on the side specified.
    pub start_line: u32,
    /// 1-based end line, inclusive.
    pub end_line: u32,
    /// Diff side (`"LEFT"` / `"RIGHT"`).
    pub side: String,
    /// Existing snippet, verbatim. The frontend also needs the
    /// `snippet_start_line` so each rendered code line carries the
    /// correct line number — we surface that field separately so
    /// older reports without it still render (line numbers fall back
    /// to `start_line`).
    #[serde(default)]
    pub current: String,
    /// 1-based line number the first character of `current`
    /// corresponds to. Defaults to `start_line` for backwards-compat.
    /// Claude is asked to provide several lines of context above the
    /// reported finding so the snippet reads coherently — that means
    /// the snippet's first line is typically a few lines *before*
    /// `start_line`. Frontend uses this field when laying out the
    /// per-line line-number gutter on the rendered card.
    #[serde(default)]
    pub snippet_start_line: Option<u32>,
    /// Suggested replacement (may be empty).
    #[serde(default)]
    pub suggested: String,
    /// Lowercase language hint for the snippet (`"rust"`, `"ts"`,
    /// `"python"`, `"css"`, `"json"`, `"bash"`, `"go"`, `"java"`,
    /// `"c"`, `"cpp"`, `"html"`, `"sql"`, …). Drives the
    /// frontend's syntax highlighter; empty means "render as plain
    /// monospaced text".
    #[serde(default)]
    pub language: String,
    /// Why this matters.
    #[serde(default)]
    pub rationale: String,
}

/// Top-level shape of `report.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportPayload {
    /// One-sentence overall verdict.
    #[serde(default)]
    pub summary: String,
    /// High-level bullet summary of the changes in the PR.
    #[serde(default)]
    pub change_summary: Vec<String>,
    /// Head SHA Claude reviewed against (sanity check).
    #[serde(default)]
    pub head_sha: String,
    /// Base SHA Claude reviewed against (sanity check).
    #[serde(default)]
    pub base_sha: String,
    /// Findings, in author-preferred order.
    #[serde(default)]
    pub findings: Vec<Finding>,
}

/// Build the index key for a PR.
pub fn index_key(pr: &PrKey) -> String {
    format!("ai_review:index:{}", pr.slug())
}

/// Build the run-record key.
pub fn run_key(run_id: &str) -> String {
    format!("ai_review:run:{run_id}")
}

/// Read the per-PR index; returns an empty list on a cache miss.
pub fn load_index(kv: &KvStore, pr: &PrKey) -> ReviewResult<Vec<RunSummary>> {
    Ok(kv.get::<Vec<RunSummary>>(&index_key(pr))?.unwrap_or_default())
}

/// Read a single run record.
pub fn load_run(kv: &KvStore, run_id: &str) -> ReviewResult<Option<RunRecord>> {
    Ok(kv.get::<RunRecord>(&run_key(run_id))?)
}

/// Persist a completed run. Updates the per-PR index (capped, newest-first).
pub fn record_completion(
    kv: &KvStore,
    pr: &PrKey,
    record: &RunRecord,
    reports_root: &Path,
) -> ReviewResult<()> {
    let mut index = load_index(kv, pr)?;
    index.retain(|s| s.run_id != record.summary.run_id);
    index.insert(0, record.summary.clone());
    if index.len() > MAX_RUNS_PER_PR {
        let dropped = index.split_off(MAX_RUNS_PER_PR);
        for old in dropped {
            kv.delete(&run_key(&old.run_id))?;
            // Best-effort cleanup of the on-disk artefacts.
            let _ = std::fs::remove_file(reports_root.join(format!("{}.html", old.run_id)));
            let _ = std::fs::remove_file(reports_root.join(format!("{}.json", old.run_id)));
        }
    }
    kv.set(&index_key(pr), &index)?;
    kv.set(&run_key(&record.summary.run_id), record)?;
    Ok(())
}

/// Delete everything we know about a PR — index entries, run records,
/// and on-disk reports. Used by the merged-PR purge.
pub fn purge_pr(kv: &KvStore, pr: &PrKey, reports_root: &Path) -> ReviewResult<u32> {
    let index = load_index(kv, pr)?;
    let mut removed = 0u32;
    for summary in &index {
        if kv.delete(&run_key(&summary.run_id)).is_ok() {
            removed += 1;
        }
        let _ = std::fs::remove_file(reports_root.join(format!("{}.html", summary.run_id)));
        let _ = std::fs::remove_file(reports_root.join(format!("{}.json", summary.run_id)));
    }
    kv.delete(&index_key(pr))?;
    Ok(removed)
}

/// Read & parse `report.json` from a worktree, returning the parsed
/// payload. Returns an [`ReviewError::ReportMissing`] if the file
/// doesn't exist; an [`ReviewError::Json`] if it's malformed.
pub fn parse_report_json(path: &Path) -> ReviewResult<ReportPayload> {
    if !path.exists() {
        return Err(ReviewError::ReportMissing {
            path: path.to_path_buf(),
        });
    }
    let raw = std::fs::read_to_string(path)?;
    let payload: ReportPayload = serde_json::from_str(&raw)?;
    Ok(payload)
}

/// Copy the worktree-local `report.json` into the reports dir at
/// `<reports_root>/<run_id>.json`. Also copies `report.html` if it
/// happens to be present (older Claude prompts wrote one; the
/// current React renderer reads only the JSON, but keeping the HTML
/// lets us inspect historical runs verbatim if needed). Returns the
/// destination paths — `(html_or_none, json)`.
pub fn persist_report_files(
    run_id: &str,
    src_html: &Path,
    src_json: &Path,
    reports_root: &Path,
) -> ReviewResult<(Option<PathBuf>, PathBuf)> {
    std::fs::create_dir_all(reports_root)?;
    let dst_json = reports_root.join(format!("{run_id}.json"));
    if !src_json.exists() {
        return Err(ReviewError::ReportMissing {
            path: src_json.to_path_buf(),
        });
    }
    std::fs::copy(src_json, &dst_json)?;
    let dst_html_opt = if src_html.exists() {
        let dst_html = reports_root.join(format!("{run_id}.html"));
        std::fs::copy(src_html, &dst_html)?;
        Some(dst_html)
    } else {
        None
    };
    Ok((dst_html_opt, dst_json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_pr(n: u64) -> PrKey {
        PrKey {
            owner: "octo".into(),
            repo: "demo".into(),
            number: n,
        }
    }

    fn make_record(run_id: &str, head_sha: &str) -> RunRecord {
        RunRecord {
            pr: make_pr(1),
            summary: RunSummary {
                run_id: run_id.into(),
                head_sha: head_sha.into(),
                model: "sonnet".into(),
                started_at_ms: 1000,
                finished_at_ms: Some(2000),
                status: RunStatus::Done,
                cost_usd: Some(0.1),
            },
            report_html_path: None,
            report_json_path: Some("/tmp/r.json".into()),
            overall_summary: String::new(),
            change_summary: Vec::new(),
            prompt: String::new(),
            findings: Vec::new(),
            events: Vec::new(),
        }
    }

    #[test]
    fn record_completion_caps_index_and_drops_oldest() {
        let dir = TempDir::new().unwrap();
        let kv = KvStore::open(":memory:").unwrap();
        let pr = make_pr(1);
        for i in 0..(MAX_RUNS_PER_PR + 3) {
            let run_id = format!("run-{i}");
            let rec = make_record(&run_id, &format!("sha-{i}"));
            record_completion(&kv, &pr, &rec, dir.path()).unwrap();
        }
        let index = load_index(&kv, &pr).unwrap();
        assert_eq!(index.len(), MAX_RUNS_PER_PR);
        // Newest-first invariant.
        assert!(index[0].run_id.ends_with(&(MAX_RUNS_PER_PR + 2).to_string()));
        // Oldest entries are gone.
        assert!(load_run(&kv, "run-0").unwrap().is_none());
    }

    #[test]
    fn purge_pr_removes_index_and_records() {
        let dir = TempDir::new().unwrap();
        let kv = KvStore::open(":memory:").unwrap();
        let pr = make_pr(2);
        let rec = make_record("only", "sha");
        record_completion(&kv, &pr, &rec, dir.path()).unwrap();
        purge_pr(&kv, &pr, dir.path()).unwrap();
        assert!(load_index(&kv, &pr).unwrap().is_empty());
        assert!(load_run(&kv, "only").unwrap().is_none());
    }
}
