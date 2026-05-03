//! Performance test commands. Loads `perf.yaml` configs, runs the
//! selected test (streaming `perf:update` events to the front-end),
//! supports stop, and exports CSV.

use crate::dto::PerfConfigDto;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::tray;
use ahash::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tracing::debug;
use zen_http::{
    has_cross_file_dependencies, resolve_execution_order, CrossFileDependencyResolver,
    FileRegistry, HttpExecutor,
};
use zen_parser::{parse_request_ref, PerfConfig, PerfTest};
use zen_perf::{metrics::MetricsSnapshot, Assertion, PerfRunner, PerfUpdate, StopHandle};
use zen_types::prelude::*;

const PERF_UPDATE_EVENT: &str = "perf:update";

/// Load a perf YAML config (with variable substitution) and store it in
/// state. Returns a DTO the front-end can render in its test list.
#[tauri::command]
pub async fn load_perf_config(
    path: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<PerfConfigDto> {
    let path_buf = PathBuf::from(&path);
    let mut config = PerfConfig::load_with_variables(&path_buf)?;

    let base_path = path_buf.parent().map(Path::to_path_buf);
    for test in &mut config.tests {
        test.base_path.clone_from(&base_path);
    }

    let dto = PerfConfigDto::from_config(&config, &path_buf);
    let mut s = state.lock().await;
    s.perf_config = Some(config);
    s.perf_config_path = Some(path_buf);
    Ok(dto)
}

/// Get the latest metrics snapshot (used for re-hydration on remount).
#[tauri::command]
pub async fn get_perf_metrics(
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<Option<MetricsSnapshot>> {
    Ok(state.lock().await.perf_metrics.clone())
}

struct PrepareResult {
    test: PerfTest,
    target: HttpRequest,
    target_local_vars: HashMap<String, String>,
    chain: Vec<HttpRequest>,
    env_vars: HashMap<String, String>,
    extracted_vars: HashMap<String, String>,
    cookies: Vec<(String, String)>,
    executor: HttpExecutor,
    file_registry: Arc<FileRegistry>,
}

/// Snapshot every input the runner needs from `AppState`. Holds the lock
/// only briefly — no `await` other than `state.lock().await`.
async fn prepare_run(
    test_index: usize,
    state: &tauri::State<'_, Mutex<AppState>>,
) -> AppResult<PrepareResult> {
    let s = state.lock().await;

    let config = s
        .perf_config
        .as_ref()
        .ok_or_else(|| AppError::NotInitialised("no perf config loaded".into()))?;
    let test = config
        .tests
        .get(test_index)
        .ok_or_else(|| AppError::BadRequest(format!("invalid test index: {test_index}")))?
        .clone();

    let (file_ref, name) = parse_request_ref(&test.request).ok_or_else(|| {
        AppError::BadRequest(format!("invalid request reference: {}", test.request))
    })?;
    let base = test.base_path.clone().or_else(|| {
        s.perf_config_path
            .as_ref()
            .and_then(|p| p.parent().map(Path::to_path_buf))
    });
    let path = base
        .map(|b| b.join(&file_ref))
        .unwrap_or_else(|| PathBuf::from(&file_ref));

    let arc_file = s.file_registry.get_or_load(&path)?;
    let target = arc_file
        .requests
        .iter()
        .find(|r| r.name.as_deref() == Some(name.as_str()))
        .cloned()
        .ok_or_else(|| AppError::BadRequest(format!("request '{name}' not found in {file_ref}")))?;

    // Build the chain of dependencies (without executing them yet).
    let chain: Vec<HttpRequest> = if target.depends_on.is_empty() {
        Vec::new()
    } else if has_cross_file_dependencies(&target) {
        let mut resolver = CrossFileDependencyResolver::new(&s.file_registry);
        let mut full = resolver.resolve(&target)?;
        // Drop the final target — the perf runner repeats it itself.
        full.pop();
        full
    } else {
        let names =
            resolve_execution_order(&arc_file.requests, &target.name.clone().unwrap_or_default())?;
        names
            .into_iter()
            .take_while(|name| Some(name.as_str()) != target.name.as_deref())
            .filter_map(|name| {
                arc_file
                    .requests
                    .iter()
                    .find(|r| r.name.as_deref() == Some(name.as_str()) || r.id == name)
                    .cloned()
            })
            .collect()
    };

    Ok(PrepareResult {
        test,
        target_local_vars: arc_file.local_variables.clone(),
        target,
        chain,
        env_vars: s.current_env_vars(),
        extracted_vars: s.current_extracted_vars(),
        cookies: s.current_cookies(),
        executor: s.executor.clone(),
        file_registry: s.file_registry.clone(),
    })
}

/// Run the test at the given index in the loaded perf config.
#[tauri::command]
pub async fn run_perf_test(
    test_index: usize,
    app_handle: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<()> {
    let prep = prepare_run(test_index, &state).await?;

    // Compile assertions early — they don't depend on the dep chain.
    let assertions: Vec<Assertion> = prep
        .target
        .assertions
        .iter()
        .filter_map(|a| Assertion::parse(a))
        .collect();

    // Hoist stop-handle creation **before** the dependency pre-run.
    // Previously we ran the deps synchronously before this block, which
    // meant a slow setup request (e.g. the 5-second dep in the example
    // perf yaml) blocked the user from clicking Stop — both because
    // `perf_running` was still false on the backend and because the
    // frontend hadn't received the `Started` event that flips its own
    // `isRunning` flag.
    let stop = StopHandle::new();
    let stop_rx = stop.subscribe();
    {
        let mut s = state.lock().await;
        s.perf_running = true;
        s.perf_stop = Some(stop);
        s.perf_metrics = None;
        s.perf_samples.clear();
        s.perf_started_at = Some(std::time::Instant::now());
    }
    // Show the tray now that work is in flight.
    let _ = tray::update(&app_handle);

    // Translator: drain PerfUpdate from runner → app_handle.emit + persist.
    let (update_tx, mut update_rx) = mpsc::channel::<PerfUpdate>(1024);
    let translator_handle = app_handle.clone();
    tokio::spawn(async move {
        while let Some(update) = update_rx.recv().await {
            let _ = translator_handle.emit(PERF_UPDATE_EVENT, &update);
            if let PerfUpdate::Progress { metrics, .. }
            | PerfUpdate::Completed {
                final_metrics: metrics,
                ..
            }
            | PerfUpdate::Stopped {
                final_metrics: metrics,
                ..
            } = &update
            {
                let state = translator_handle.state::<Mutex<AppState>>();
                state.lock().await.perf_metrics = Some(metrics.clone());
            }
        }
    });

    // Emit Started **before** the dep pre-run so the frontend can flip
    // `isRunning = true` and the user can hit Stop while the setup is
    // still in flight.
    let _ = update_tx
        .send(PerfUpdate::Started {
            test_name: prep.test.name.clone(),
        })
        .await;

    let runner = PerfRunner::new(prep.executor.clone(), update_tx.clone());
    let test_clone = prep.test.clone();
    let target = prep.target;
    let env_vars = prep.env_vars;
    let target_local_vars = prep.target_local_vars;
    let chain = prep.chain;
    let registry = prep.file_registry;
    let executor = prep.executor;
    let mut extracted_vars = prep.extracted_vars;
    let mut cookies = prep.cookies;
    let stop_rx_for_task = stop_rx.clone();

    tokio::spawn(async move {
        let _keepalive = registry.clone();

        // Dep pre-run — cancellable both *between* and *within*
        // requests. Each execute() future is raced against stop_rx
        // via `tokio::select!`; if the user clicks Stop, we drop the
        // in-flight future (reqwest cancels the request) and bail
        // immediately. Without this, a 5s setup request would block
        // the entire test until it finished even after Stop.
        let mut dep_stop_rx = stop_rx_for_task.clone();
        let mut cancelled = false;
        for dep in &chain {
            if *dep_stop_rx.borrow() {
                cancelled = true;
                break;
            }
            let dep_locals = dep
                .source_file
                .as_deref()
                .map(std::path::PathBuf::from)
                .and_then(|p| registry.get_or_load(&p).ok())
                .map(|f| f.local_variables.clone())
                .unwrap_or_else(|| target_local_vars.clone());

            let exec_fut = executor.execute(
                dep,
                &extracted_vars,
                &dep_locals,
                &env_vars,
                &cookies,
            );
            tokio::select! {
                biased;
                _ = dep_stop_rx.changed() => {
                    if *dep_stop_rx.borrow() {
                        cancelled = true;
                        break;
                    }
                }
                result = exec_fut => {
                    extracted_vars.extend(result.extracted_vars);
                    cookies.extend(result.new_cookies);
                }
            }
        }

        if cancelled || *stop_rx_for_task.borrow() {
            let _ = update_tx
                .send(PerfUpdate::Stopped {
                    test_name: test_clone.name.clone(),
                    final_metrics: MetricsSnapshot::default(),
                })
                .await;
            {
                let state = app_handle.state::<Mutex<AppState>>();
                let mut s = state.lock().await;
                s.perf_running = false;
                s.perf_stop = None;
            }
            // Tray hides if neither perf nor monitoring is active.
            let _ = tray::update(&app_handle);
            return;
        }

        let _ = runner
            .run_test(
                &test_clone,
                target,
                assertions,
                env_vars,
                extracted_vars,
                target_local_vars,
                stop_rx_for_task,
            )
            .await;
        {
            let state = app_handle.state::<Mutex<AppState>>();
            let mut s = state.lock().await;
            s.perf_running = false;
            s.perf_stop = None;
        }
        // Tray hides if neither perf nor monitoring is active.
        let _ = tray::update(&app_handle);
        debug!("perf test finished");
    });

    Ok(())
}

/// Cancel the in-flight perf test.
#[tauri::command]
pub async fn stop_perf_test(state: tauri::State<'_, Mutex<AppState>>) -> AppResult<()> {
    let s = state.lock().await;
    if let Some(handle) = &s.perf_stop {
        handle.stop();
    }
    Ok(())
}

/// Export the latest perf run's summary CSV to the working dir.
#[tauri::command]
pub async fn export_perf_results(
    output_dir: Option<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> AppResult<String> {
    let s = state.lock().await;
    let metrics = s
        .perf_metrics
        .as_ref()
        .ok_or_else(|| AppError::NotInitialised("no perf metrics to export".into()))?
        .clone();
    // Fall back to the first open project when no explicit output dir
    // is provided. Multi-root setups can pass a path explicitly.
    let dir = match output_dir
        .map(PathBuf::from)
        .or_else(|| s.working_dirs.first().cloned())
    {
        Some(d) => d,
        None => {
            return Err(AppError::NotInitialised(
                "no output directory: add a project or pass output_dir".into(),
            ))
        }
    };

    let test_name = s
        .perf_config
        .as_ref()
        .and_then(|c| c.tests.first().map(|t| t.name.clone()))
        .unwrap_or_else(|| "perf".to_string());

    let safe_name: String = test_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let summary_path = dir.join(format!("{safe_name}_{timestamp}_summary.csv"));
    let mut file = std::fs::File::create(&summary_path)?;
    zen_perf::export_summary_csv(&mut file, &test_name, &metrics)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(summary_path.display().to_string())
}
