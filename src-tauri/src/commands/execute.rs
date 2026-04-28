//! Execution commands — run a single request, run a request with its
//! full dependency chain, and build a curl-equivalent string.
//!
//! Both run commands return immediately and stream their progress as
//! `request:result` events (and one `request:chain` event for the with-deps
//! variant).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use ahash::HashMap;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tracing::debug;
use zen_http::{
    has_cross_file_dependencies, resolve_execution_order, CrossFileDependencyResolver,
    HttpExecutor,
};
use zen_types::prelude::*;

const REQUEST_RESULT_EVENT: &str = "request:result";
const REQUEST_CHAIN_EVENT: &str = "request:chain";

#[derive(Debug, Clone, Serialize)]
struct ChainStep {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChainPayload {
    steps: Vec<ChainStep>,
}

/// Run a single request with no dependency resolution. Emits a Running
/// status, executes, then emits the final Success / Error.
#[tauri::command]
pub async fn run_request(
    file_path: String,
    request_id: String,
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let RunContext {
        request,
        executor,
        env_vars,
        extracted,
        local_vars,
        cookies,
    } = prepare_run(&file_path, &request_id, &state).await?;

    spawn_chain_run(
        app_handle,
        executor,
        env_vars,
        extracted,
        local_vars,
        cookies,
        vec![request],
    );
    Ok(())
}

/// Run a request with full dependency resolution (local + cross-file).
/// Emits `request:chain` once at the start describing the planned order,
/// then `request:result` for each step.
#[tauri::command]
pub async fn run_request_with_deps(
    file_path: String,
    request_id: String,
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let chain = build_chain(&file_path, &request_id, &state).await?;

    // Emit the planned chain once so the UI can render the dependency view
    // immediately.
    let steps: Vec<ChainStep> = chain
        .iter()
        .map(|r| ChainStep {
            id: r.stable_id(),
            name: r.name.clone().unwrap_or_else(|| "(anonymous)".into()),
        })
        .collect();
    let _ = app_handle.emit(REQUEST_CHAIN_EVENT, ChainPayload { steps });

    let (executor, env_vars, extracted, local_vars, cookies) = {
        let s = state.lock().await;
        (
            s.executor.clone(),
            s.current_env_vars(),
            s.current_extracted_vars(),
            HashMap::default(),
            s.current_cookies(),
        )
    };

    spawn_chain_run(
        app_handle,
        executor,
        env_vars,
        extracted,
        local_vars,
        cookies,
        chain,
    );
    Ok(())
}

/// Build a curl command line for the given request, with all variables
/// resolved against the current context.
#[tauri::command]
pub async fn build_curl_command(
    file_path: String,
    request_id: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<String> {
    let RunContext {
        request,
        env_vars,
        extracted,
        local_vars,
        cookies,
        ..
    } = prepare_run(&file_path, &request_id, &state).await?;

    let url = zen_http::substitute_variables(&request.url, &extracted, &local_vars, &env_vars);
    let mut parts = vec![format!("curl -X {} {:?}", request.method, url)];

    for (k, v) in &request.headers {
        let resolved = zen_http::substitute_variables(v, &extracted, &local_vars, &env_vars);
        parts.push(format!("-H {:?}", format!("{k}: {resolved}")));
    }
    if !cookies.is_empty() {
        let header = cookies
            .iter()
            .map(|(n, v)| format!("{n}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        parts.push(format!("-H {:?}", format!("Cookie: {header}")));
    }
    if let Some(body) = &request.body {
        let resolved = zen_http::substitute_variables(body, &extracted, &local_vars, &env_vars);
        parts.push(format!("--data-raw {resolved:?}"));
    }
    Ok(parts.join(" \\\n  "))
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

struct RunContext {
    request: HttpRequest,
    executor: HttpExecutor,
    env_vars: HashMap<String, String>,
    extracted: HashMap<String, String>,
    local_vars: HashMap<String, String>,
    cookies: Vec<(String, String)>,
}

/// Locate the request inside the registry-cached file and snapshot every
/// piece of context needed to run it. Holds the lock only briefly.
async fn prepare_run(
    file_path: &str,
    request_id: &str,
    state: &tauri::State<'_, Mutex<AppState>>,
) -> AppResult<RunContext> {
    let s = state.lock().await;
    let arc_file = s.file_registry.get_or_load(Path::new(file_path))?;
    let request = arc_file
        .requests
        .iter()
        .find(|r| r.stable_id() == request_id || r.id == request_id)
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest(format!("request not found: {request_id}"))
        })?;
    Ok(RunContext {
        executor: s.executor.clone(),
        env_vars: s.current_env_vars(),
        extracted: s.current_extracted_vars(),
        local_vars: arc_file.local_variables.clone(),
        cookies: s.current_cookies(),
        request,
    })
}

/// Build the full execution chain for a target request, including local
/// + cross-file dependencies in topological order.
async fn build_chain(
    file_path: &str,
    request_id: &str,
    state: &tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Vec<HttpRequest>> {
    let s = state.lock().await;
    let arc_file = s.file_registry.get_or_load(Path::new(file_path))?;
    let target = arc_file
        .requests
        .iter()
        .find(|r| r.stable_id() == request_id || r.id == request_id)
        .cloned()
        .ok_or_else(|| AppError::BadRequest(format!("request not found: {request_id}")))?;

    // No deps → single-element chain.
    if target.depends_on.is_empty() {
        return Ok(vec![target]);
    }

    if has_cross_file_dependencies(&target) {
        let registry = s.file_registry.clone();
        drop(s);
        let mut resolver = CrossFileDependencyResolver::new(&registry);
        let chain = resolver.resolve(&target)?;
        return Ok(chain);
    }

    // Local-only deps.
    let order = resolve_execution_order(&arc_file.requests, &target.name.clone().unwrap_or_else(|| target.id.clone()))?;
    let mut chain = Vec::with_capacity(order.len());
    for name in order {
        if let Some(req) = arc_file
            .requests
            .iter()
            .find(|r| r.name.as_deref() == Some(name.as_str()) || r.id == name)
            .cloned()
        {
            chain.push(req);
        }
    }
    Ok(chain)
}

/// Spawn a tokio task that runs the chain step-by-step, emitting events
/// and persisting extracted vars + cookies after the chain completes.
#[allow(clippy::too_many_arguments)]
fn spawn_chain_run(
    app_handle: AppHandle,
    executor: HttpExecutor,
    env_vars: HashMap<String, String>,
    mut extracted: HashMap<String, String>,
    initial_local: HashMap<String, String>,
    mut cookies: Vec<(String, String)>,
    chain: Vec<HttpRequest>,
) {
    tokio::spawn(async move {
        let mut chain_extracted: HashMap<String, String> = HashMap::default();
        let mut chain_cookies: Vec<(String, String)> = Vec::new();

        for (idx, req) in chain.iter().enumerate() {
            let stable_id = req.stable_id();
            let is_last = idx + 1 == chain.len();
            let label = req.name.as_deref().unwrap_or("(anonymous)");
            let running_msg = if is_last {
                format!("Running: {label}")
            } else {
                format!("Running dependency: {label}")
            };

            let running_result =
                RequestResult::running_with_message(stable_id.clone(), running_msg);
            let _ = app_handle.emit(REQUEST_RESULT_EVENT, &running_result);

            let local_vars = initial_local.clone();
            let result = executor
                .execute(req, &extracted, &local_vars, &env_vars, &cookies)
                .await;

            // Carry extracted + cookies into subsequent steps.
            for (k, v) in &result.extracted_vars {
                extracted.insert(k.clone(), v.clone());
                chain_extracted.insert(k.clone(), v.clone());
            }
            for c in &result.new_cookies {
                cookies.push(c.clone());
                chain_cookies.push(c.clone());
            }

            let _ = app_handle.emit(REQUEST_RESULT_EVENT, &result);
        }

        // Persist back to the shared state (re-acquires the Mutex once).
        let state = app_handle.state::<Mutex<AppState>>();
        let mut s = state.lock().await;
        s.persist_extracted(chain_extracted);
        s.persist_cookies(chain_cookies);
        debug!("chain complete; extracted vars persisted");
    });
}
