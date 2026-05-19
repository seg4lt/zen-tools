//! Review prompt + embedded HTML report template.
//!
//! We hand Claude one prompt that:
//! 1. Tells it the base/head SHAs and the workspace it's running in.
//! 2. Asks it to trace through the diff, evaluating correctness,
//!    edge cases, security, performance, maintainability, and tests.
//! 3. Requires it to emit two artefacts at deterministic paths:
//!    `.zen-review/report.html` (self-contained, severity-grouped UI)
//!    and `.zen-review/report.json` (machine-readable findings the
//!    backend uses to wire each "Post inline comment" button to the
//!    existing `prmaster_add_review_comment` flow).
//!
//! The HTML template lives here as a `&str` so frontend code never
//! needs to host a separate fixture. Keep it self-contained: inline
//! `<style>`, no external assets, no scripts beyond the one used to
//! `postMessage` finding ids back to the host.

/// Filename Claude must write the machine-readable findings JSON at,
/// relative to its cwd. The host renders the UI directly from this
/// JSON in React, so there's no longer an HTML report Claude needs
/// to produce.
pub const REPORT_JSON_REL: &str = ".zen-review/report.json";

/// Legacy HTML report path. Kept around so older runs persisted before
/// the React-native renderer landed still resolve. Never written by
/// new runs.
pub const REPORT_HTML_REL: &str = ".zen-review/report.html";

/// Embedded HTML skeleton — kept only so historical reports the user
/// generated before the React renderer landed still inspect cleanly.
/// New runs do NOT consume this; the prompt no longer asks Claude
/// for HTML.
#[allow(dead_code)]
const HTML_TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AI Code Review</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0d12;
    --surface: #11141b;
    --border: #1e222d;
    --text: #e7eaf0;
    --muted: #9aa3b2;
    --crit: #ef4444;
    --high: #f59e0b;
    --med:  #3b82f6;
    --low:  #14b8a6;
    --code-bg: #0a0c10;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --surface: #f7f7fb;
      --border: #e5e7eb;
      --text: #11141b;
      --muted: #4b5563;
      --code-bg: #f3f4f6;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    font-size: 13px; line-height: 1.5; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; margin: 24px 0 8px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em; }
  .summary { color: var(--muted); margin-bottom: 16px; }
  .meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted);
    font-size: 11px; margin-bottom: 16px; }
  .meta span { background: var(--surface); border: 1px solid var(--border);
    padding: 2px 8px; border-radius: 999px; }
  .finding { background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .finding header { display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px; }
  .badge { font-size: 10px; padding: 2px 8px; border-radius: 999px;
    font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
  .badge.crit { background: rgba(239, 68, 68, 0.15); color: var(--crit); }
  .badge.high { background: rgba(245, 158, 11, 0.15); color: var(--high); }
  .badge.med  { background: rgba(59, 130, 246, 0.15); color: var(--med); }
  .badge.low  { background: rgba(20, 184, 166, 0.15); color: var(--low); }
  .finding h3 { margin: 0; font-size: 13px; flex: 1; }
  .finding code.loc { font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px; color: var(--muted); }
  .finding pre { margin: 6px 0; background: var(--code-bg);
    border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
    overflow-x: auto; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px; line-height: 1.45; }
  .label { font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.08em; margin-top: 8px; }
  .rationale { color: var(--text); margin: 6px 0 8px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { font: inherit; font-size: 11px; padding: 4px 10px;
    border-radius: 6px; border: 1px solid var(--border); background: transparent;
    color: var(--text); cursor: pointer; }
  .actions button:hover { background: var(--code-bg); }
  .empty { color: var(--muted); padding: 20px; text-align: center;
    background: var(--surface); border: 1px dashed var(--border);
    border-radius: 10px; }
</style>
</head>
<body>
<main>
  <h1>AI Code Review</h1>
  <p class="summary"><!-- one-sentence summary here --></p>
  <div class="meta">
    <span>head: <!-- short head sha --></span>
    <span>base: <!-- short base sha --></span>
    <span>findings: <!-- count --></span>
  </div>

  <h2>Critical</h2>
  <section data-severity="critical">
    <!-- repeat for each Critical finding:
    <article class="finding" data-finding-id="FID">
      <header>
        <span class="badge crit">critical</span>
        <h3>One-line title</h3>
        <code class="loc">path/to/file.rs:120-128</code>
      </header>
      <div class="label">Current</div>
      <pre>existing snippet</pre>
      <div class="label">Suggested</div>
      <pre>suggested replacement</pre>
      <div class="label">Why</div>
      <p class="rationale">Reasoning.</p>
      <div class="actions">
        <button onclick="postFinding('FID')">Post inline comment</button>
      </div>
    </article>
    -->
    <p class="empty">No critical findings.</p>
  </section>

  <h2>High</h2>
  <section data-severity="high">
    <p class="empty">No high findings.</p>
  </section>

  <h2>Medium</h2>
  <section data-severity="medium">
    <p class="empty">No medium findings.</p>
  </section>

  <h2>Low</h2>
  <section data-severity="low">
    <p class="empty">No low findings.</p>
  </section>
</main>
<script>
  function postFinding(id) {
    try { window.parent.postMessage({ kind: "ai-review:post-finding", findingId: id }, "*"); }
    catch (_e) { /* host iframe handles failures */ }
  }
</script>
</body>
</html>
"##;

/// Build the prompt handed to `claude -p`.
///
/// `worktree_dir` is the absolute path Claude will run inside (used
/// for orientation in the prompt; the spawn layer still passes it as
/// `cwd`).  When `base_sha` is `None` we tell Claude to resolve it
/// itself via `git merge-base origin/<base_branch> HEAD`, since the
/// caller often only knows the base branch name.
pub fn build_review_prompt(
    base_sha: Option<&str>,
    head_sha: &str,
    head_branch: Option<&str>,
    base_branch: Option<&str>,
    pr_url: Option<&str>,
    worktree_dir: &str,
) -> String {
    let head_branch = head_branch.unwrap_or("(unknown)");
    let base_branch_label = base_branch.unwrap_or("(unknown)");
    let pr_url = pr_url.unwrap_or("(not provided)");
    let base_sha_label: &str = base_sha.unwrap_or("");
    let (base_label, diff_cmd, log_cmd) = match base_sha {
        Some(sha) if !sha.is_empty() => (
            format!("{base_branch_label} (sha {sha})"),
            format!("git diff {sha}..{head_sha}"),
            format!("git log {sha}..{head_sha}"),
        ),
        _ => {
            let bb = base_branch.unwrap_or("main");
            (
                format!("{base_branch_label} (sha to be resolved via `git merge-base origin/{bb} HEAD`)"),
                format!("BASE=$(git merge-base origin/{bb} HEAD); git diff $BASE..{head_sha}"),
                format!("BASE=$(git merge-base origin/{bb} HEAD); git log $BASE..{head_sha}"),
            )
        }
    };
    format!(
        r##"You are performing a thorough code review of a GitHub pull request.

CONTEXT
- Working directory: {worktree_dir}
- Base branch: {base_label}
- Head branch: {head_branch} (sha {head_sha})
- PR URL: {pr_url}
- The working directory is a detached git worktree pinned to the head sha.

WHAT TO DO
1. Run `{diff_cmd}` to enumerate the changes. Use `{log_cmd}` to read commit messages for intent.
2. **Trace before you judge.** A diff window is rarely enough context to call a finding. For every non-trivial change you flag, you MUST first gather evidence from outside the diff:
   - **Call-graph trace.** `Grep` (or `rg` via Bash) repo-wide for every modified function / method / type / constant — find every caller, every test that exercises it, every config that references it. If a public symbol's signature or contract changed, list the call sites that look impacted.
   - **Pattern search.** Look for similar idioms elsewhere in the codebase (`rg -tsomething "pattern"`). If the change diverges from an established pattern, that's worth flagging; if it converges with one, that strengthens the rationale.
   - **Test coverage.** `Glob` for `**/*test*` / `**/__tests__/**` / `**/*_test.rs` near the changed file; check whether the new behaviour has tests and whether existing tests would catch a regression of the change's intent.
   - **Adjacent code.** Read the file around each edit (a few hundred lines, not just the hunk). Look for invariants the diff might break, error paths that aren't handled, lifetimes that change, locks that are held across the new code, etc.
   - **Configs / manifests.** When a file imports something new or bumps a dependency, glance at `package.json` / `Cargo.toml` / `go.mod` / `requirements.txt` / build scripts to see what else is in the dependency tree.
3. **Then evaluate**: correctness, edge cases, security, performance, maintainability, test coverage. Tie each finding to the concrete evidence you gathered — name the specific file, line, caller, or test you saw. Findings without grounded evidence (just "looks fragile") should be skipped or downgraded.
4. **Quality bar.** Prefer fewer high-signal findings over many low-signal ones. Skip stylistic nits unless they actually hurt readability or correctness. If the change is genuinely fine, return an empty `findings` array and say so in `summary` — don't manufacture issues to fill space.
5. You MUST NOT modify the source tree. The Edit / Write / MultiEdit tools are disabled. Use Read, Grep, Glob, Bash for inspection only.
6. The Bash tool is available — use it for `git diff`, `git log`, `rg`, `cat`, `head`, `tail`, etc. Do not run anything that mutates the repo or reaches the network beyond `git fetch`.

OUTPUT — ONE MANDATORY ARTEFACT
Create the directory `.zen-review/` (relative to your working directory) and write
`.zen-review/report.json` (the host renders the UI from this; you do NOT need to
generate HTML).

SCHEMA:
{{
  "summary": "one sentence overall verdict",
  "change_summary": [
    "high-level bullet describing what changed",
    "another high-level bullet describing changed behavior, APIs, data flow, tests, or UI"
  ],
  "head_sha": "{head_sha}",
  "base_sha": "{base_sha_label}",
  "findings": [
    {{
      "id": "stable-slug-unique-per-finding",
      "severity": "critical" | "high" | "medium" | "low",
      "title": "short, specific title (≤ 80 chars)",
      "path": "relative/path/from/worktree/root.ext",
      "start_line": 120,
      "end_line": 128,
      "side": "RIGHT",
      "language": "rust",
      "snippet_start_line": 117,
      "current": "<the snippet, including 3-5 lines of CONTEXT above and below the finding>",
      "suggested": "<the rewritten snippet OR an explicit '(remove these lines)' / empty string when not applicable>",
      "rationale": "Why this matters. Reference specific identifiers and call-sites. 2-5 sentences."
    }}
  ]
}}

FIELD RULES — read carefully, the host UI depends on every one of these:
- `change_summary` is required. Provide 3-6 concise, high-level bullet strings that summarize what the PR changes before discussing findings. Focus on user-visible behavior, important implementation shifts, data/model changes, tests, and operational impact. Do not mention line numbers here.
- `path` is relative to the worktree root (so e.g. `src/foo/bar.rs`). NEVER use absolute paths.
- `side` is "RIGHT" for findings on new/changed code (the common case), "LEFT" only for lines that the PR removed.
- `start_line` / `end_line` are the 1-based, inclusive line range of the **finding itself** (not the context). They anchor the GitHub inline review comment when the user clicks "Post inline comment".
- `snippet_start_line` is the 1-based line number of the **first line of the `current` snippet**. This is typically `start_line - 3` (because you must include 3-5 lines of context above the finding) but may be 1 if the finding is at the top of the file.
- `current` MUST include 3-5 lines of context above AND below the actual problem so the reviewer can see the surrounding code without leaving the report. Do not paste the entire file; keep it focused. Verbatim from the source — preserve indentation exactly.
- `suggested` should be a drop-in replacement for `current`'s problem region (with the same surrounding context), OR the literal string "(remove these lines)" when the fix is deletion, OR "" when there is no concrete suggestion.
- `language` is a lowercase identifier the renderer maps to a syntax highlighter: `"rust"`, `"ts"`, `"js"`, `"tsx"`, `"jsx"`, `"python"`, `"go"`, `"java"`, `"c"`, `"cpp"`, `"css"`, `"html"`, `"json"`, `"yaml"`, `"toml"`, `"sql"`, `"bash"`, `"sh"`, `"md"`. Use the closest match for the file extension; leave empty if unsure.
- `rationale` should reference specific identifiers, call-sites, or external constraints — not vague advice. Aim for 2-5 sentences. Skip generic platitudes.
- `id` is a stable kebab-case slug like `crit-tokio-spawn-leak-runner-rs-114`. Used as a stable handle by the host UI.

QUALITY BAR:
- Prefer fewer, higher-signal findings over many low-signal ones. Skip stylistic nits unless they materially hurt readability or correctness.
- Ground every finding in evidence from the worktree — read the file, search for callers, check tests. Don't invent issues that aren't there.
- If the change is genuinely fine, return an empty `findings` array and say so in `summary`.

When the report is written, finish with one short sentence summarising the review.
"##
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_mentions_artefact_path_and_diff() {
        let p = build_review_prompt(
            Some("aaaa"),
            "bbbb",
            Some("feat/x"),
            Some("main"),
            None,
            "/tmp/wt",
        );
        assert!(p.contains(REPORT_JSON_REL));
        assert!(p.contains("aaaa..bbbb"));
        assert!(p.contains("/tmp/wt"));
        assert!(p.contains("language"));
        assert!(p.contains("snippet_start_line"));
    }

    #[test]
    fn prompt_falls_back_to_merge_base_when_base_sha_missing() {
        let p = build_review_prompt(None, "bbbb", Some("feat/x"), Some("main"), None, "/tmp/wt");
        assert!(p.contains("git merge-base origin/main HEAD"));
        assert!(p.contains("/tmp/wt"));
    }
}
