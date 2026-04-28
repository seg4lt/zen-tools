//! Concurrent / stress / spike / soak load test orchestration.

use crate::assertion::Assertion;
use crate::error::PerfError;
use crate::metrics::{MetricsCollector, MetricsSnapshot, RequestSample};
use ahash::HashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::time::{interval, sleep};
use tracing::{debug, instrument};
use zen_http::HttpExecutor;
use zen_parser::perf_config::{PerfTest, TestType};
use zen_types::prelude::*;

/// Streaming update messages emitted by [`PerfRunner`].
///
/// The Tauri layer forwards these to the front-end as `perf:update`
/// events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PerfUpdate {
    /// Test has begun.
    Started {
        /// Display name of the test.
        test_name: String,
    },
    /// Periodic progress sample.
    Progress {
        /// Current snapshot.
        metrics: MetricsSnapshot,
        /// Currently running concurrent users.
        current_users: u32,
        /// Total target duration in milliseconds.
        target_duration_ms: u64,
    },
    /// Test completed normally.
    Completed {
        /// Display name of the test.
        test_name: String,
        /// Final metrics snapshot.
        final_metrics: MetricsSnapshot,
    },
    /// Test cancelled by user.
    Stopped {
        /// Display name of the test.
        test_name: String,
        /// Final metrics snapshot.
        final_metrics: MetricsSnapshot,
    },
    /// Runtime error.
    Error {
        /// Display name of the test.
        test_name: String,
        /// Error message.
        message: String,
    },
}

/// Performance test runner. Cheap to construct; the underlying executor
/// shares its connection pool across all spawned worker tasks.
pub struct PerfRunner {
    executor: Arc<HttpExecutor>,
    update_tx: mpsc::Sender<PerfUpdate>,
}

impl PerfRunner {
    /// Construct from an executor and an update sender. The receiver side
    /// is owned by the caller (Tauri command, CLI, etc.).
    pub fn new(executor: HttpExecutor, update_tx: mpsc::Sender<PerfUpdate>) -> Self {
        Self {
            executor: Arc::new(executor),
            update_tx,
        }
    }

    /// Run the configured test. Returns the final metrics snapshot.
    #[allow(clippy::too_many_arguments)]
    #[instrument(skip_all, fields(test = %test.name))]
    pub async fn run_test(
        &self,
        test: &PerfTest,
        request: HttpRequest,
        assertions: Vec<Assertion>,
        env_vars: HashMap<String, String>,
        extracted_vars: HashMap<String, String>,
        local_vars: HashMap<String, String>,
        stop_rx: watch::Receiver<bool>,
    ) -> Result<MetricsSnapshot, PerfError> {
        let _ = self
            .update_tx
            .send(PerfUpdate::Started {
                test_name: test.name.clone(),
            })
            .await;

        let collector = Arc::new(Mutex::new(MetricsCollector::new()));

        let result = match &test.test_type {
            TestType::Atomic => {
                self.run_atomic(
                    &request,
                    &assertions,
                    &env_vars,
                    &extracted_vars,
                    &local_vars,
                    collector.clone(),
                )
                .await
            }
            TestType::Concurrent { users, duration, .. } => {
                self.run_concurrent(
                    &request,
                    &assertions,
                    *users,
                    *duration,
                    &env_vars,
                    &extracted_vars,
                    &local_vars,
                    collector.clone(),
                    stop_rx,
                )
                .await
            }
            TestType::Stress {
                start_users,
                end_users,
                ramp_up,
                duration,
                ..
            } => {
                self.run_stress(
                    &request,
                    &assertions,
                    *start_users,
                    *end_users,
                    *ramp_up,
                    *duration,
                    &env_vars,
                    &extracted_vars,
                    &local_vars,
                    collector.clone(),
                    stop_rx,
                )
                .await
            }
            TestType::Spike {
                base_users,
                spike_users,
                spike_duration,
                total_duration,
                ..
            } => {
                self.run_spike(
                    &request,
                    &assertions,
                    *base_users,
                    *spike_users,
                    *spike_duration,
                    *total_duration,
                    &env_vars,
                    &extracted_vars,
                    &local_vars,
                    collector.clone(),
                    stop_rx,
                )
                .await
            }
            TestType::Soak { users, duration, .. } => {
                self.run_concurrent(
                    &request,
                    &assertions,
                    *users,
                    *duration,
                    &env_vars,
                    &extracted_vars,
                    &local_vars,
                    collector.clone(),
                    stop_rx,
                )
                .await
            }
        };

        let final_metrics = collector.lock().await.snapshot();

        match result {
            Ok(stopped) => {
                let update = if stopped {
                    PerfUpdate::Stopped {
                        test_name: test.name.clone(),
                        final_metrics: final_metrics.clone(),
                    }
                } else {
                    PerfUpdate::Completed {
                        test_name: test.name.clone(),
                        final_metrics: final_metrics.clone(),
                    }
                };
                let _ = self.update_tx.send(update).await;
                Ok(final_metrics)
            }
            Err(e) => {
                let _ = self
                    .update_tx
                    .send(PerfUpdate::Error {
                        test_name: test.name.clone(),
                        message: e.to_string(),
                    })
                    .await;
                Err(e)
            }
        }
    }

    async fn run_atomic(
        &self,
        request: &HttpRequest,
        assertions: &[Assertion],
        env_vars: &HashMap<String, String>,
        extracted_vars: &HashMap<String, String>,
        local_vars: &HashMap<String, String>,
        collector: Arc<Mutex<MetricsCollector>>,
    ) -> Result<bool, PerfError> {
        let start = Instant::now();
        let result = self
            .executor
            .execute(request, extracted_vars, local_vars, env_vars, &[])
            .await;
        let duration = start.elapsed();

        let sample = sample_from_status(&result.status, duration, assertions);
        collector.lock().await.record(sample);

        Ok(false)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_concurrent(
        &self,
        request: &HttpRequest,
        assertions: &[Assertion],
        users: u32,
        duration: Duration,
        env_vars: &HashMap<String, String>,
        extracted_vars: &HashMap<String, String>,
        local_vars: &HashMap<String, String>,
        collector: Arc<Mutex<MetricsCollector>>,
        mut stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, PerfError> {
        let (sample_tx, mut sample_rx) = mpsc::channel::<RequestSample>(1024);
        let (user_stop_tx, _) = watch::channel(false);

        let mut handles = Vec::with_capacity(users as usize);
        for _ in 0..users {
            handles.push(self.spawn_user(
                request.clone(),
                assertions.to_vec(),
                env_vars.clone(),
                extracted_vars.clone(),
                local_vars.clone(),
                sample_tx.clone(),
                user_stop_tx.subscribe(),
            ));
        }
        drop(sample_tx);

        let start = Instant::now();
        let mut progress = interval(Duration::from_millis(100));
        let mut history = interval(Duration::from_secs(1));

        loop {
            tokio::select! {
                Some(sample) = sample_rx.recv() => {
                    collector.lock().await.record(sample);
                }
                _ = progress.tick() => {
                    let mut c = collector.lock().await;
                    c.update_history();
                    let snapshot = c.snapshot();
                    drop(c);
                    let _ = self.update_tx.send(PerfUpdate::Progress {
                        metrics: snapshot,
                        current_users: users,
                        target_duration_ms: duration.as_millis() as u64,
                    }).await;
                }
                _ = history.tick() => {
                    collector.lock().await.update_history();
                }
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        return Ok(true);
                    }
                }
                _ = sleep(Duration::from_millis(50)) => {
                    if start.elapsed() >= duration {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        return Ok(false);
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_stress(
        &self,
        request: &HttpRequest,
        assertions: &[Assertion],
        start_users: u32,
        end_users: u32,
        ramp_up: Duration,
        duration: Duration,
        env_vars: &HashMap<String, String>,
        extracted_vars: &HashMap<String, String>,
        local_vars: &HashMap<String, String>,
        collector: Arc<Mutex<MetricsCollector>>,
        mut stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, PerfError> {
        let (sample_tx, mut sample_rx) = mpsc::channel::<RequestSample>(1024);
        let (user_stop_tx, _) = watch::channel(false);

        let mut handles = Vec::new();
        let mut current_users = start_users;
        for _ in 0..start_users {
            handles.push(self.spawn_user(
                request.clone(),
                assertions.to_vec(),
                env_vars.clone(),
                extracted_vars.clone(),
                local_vars.clone(),
                sample_tx.clone(),
                user_stop_tx.subscribe(),
            ));
        }

        let start = Instant::now();
        let users_to_add = end_users.saturating_sub(start_users);
        let ramp_step_ms = if users_to_add > 0 {
            (ramp_up.as_millis() as u64 / users_to_add as u64).max(100)
        } else {
            u64::MAX
        };

        let mut progress = interval(Duration::from_millis(100));
        let mut ramp = interval(Duration::from_millis(ramp_step_ms));

        loop {
            tokio::select! {
                Some(sample) = sample_rx.recv() => {
                    collector.lock().await.record(sample);
                }
                _ = progress.tick() => {
                    let mut c = collector.lock().await;
                    c.update_history();
                    let snapshot = c.snapshot();
                    drop(c);
                    let _ = self.update_tx.send(PerfUpdate::Progress {
                        metrics: snapshot,
                        current_users,
                        target_duration_ms: duration.as_millis() as u64,
                    }).await;
                }
                _ = ramp.tick() => {
                    if start.elapsed() < ramp_up && current_users < end_users {
                        handles.push(self.spawn_user(
                            request.clone(),
                            assertions.to_vec(),
                            env_vars.clone(),
                            extracted_vars.clone(),
                            local_vars.clone(),
                            sample_tx.clone(),
                            user_stop_tx.subscribe(),
                        ));
                        current_users += 1;
                    }
                }
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        return Ok(true);
                    }
                }
                _ = sleep(Duration::from_millis(50)) => {
                    if start.elapsed() >= duration {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        return Ok(false);
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_spike(
        &self,
        request: &HttpRequest,
        assertions: &[Assertion],
        base_users: u32,
        spike_users: u32,
        spike_duration: Duration,
        total_duration: Duration,
        env_vars: &HashMap<String, String>,
        extracted_vars: &HashMap<String, String>,
        local_vars: &HashMap<String, String>,
        collector: Arc<Mutex<MetricsCollector>>,
        mut stop_rx: watch::Receiver<bool>,
    ) -> Result<bool, PerfError> {
        let (sample_tx, mut sample_rx) = mpsc::channel::<RequestSample>(1024);
        let (user_stop_tx, _) = watch::channel(false);

        let mut handles = Vec::new();
        let mut current_users = base_users;
        for _ in 0..base_users {
            handles.push(self.spawn_user(
                request.clone(),
                assertions.to_vec(),
                env_vars.clone(),
                extracted_vars.clone(),
                local_vars.clone(),
                sample_tx.clone(),
                user_stop_tx.subscribe(),
            ));
        }

        let start = Instant::now();
        let spike_start_at = total_duration / 3;
        let spike_end_at = spike_start_at + spike_duration;
        let mut spike_applied = false;
        let mut spike_handles = Vec::<tokio::task::JoinHandle<()>>::new();

        let mut progress = interval(Duration::from_millis(100));

        loop {
            tokio::select! {
                Some(sample) = sample_rx.recv() => {
                    collector.lock().await.record(sample);
                }
                _ = progress.tick() => {
                    let elapsed = start.elapsed();
                    let mut c = collector.lock().await;
                    c.update_history();
                    let snapshot = c.snapshot();
                    drop(c);

                    if !spike_applied && elapsed >= spike_start_at {
                        for _ in 0..(spike_users.saturating_sub(base_users)) {
                            spike_handles.push(self.spawn_user(
                                request.clone(),
                                assertions.to_vec(),
                                env_vars.clone(),
                                extracted_vars.clone(),
                                local_vars.clone(),
                                sample_tx.clone(),
                                user_stop_tx.subscribe(),
                            ));
                        }
                        current_users = spike_users;
                        spike_applied = true;
                        debug!("spike applied: {current_users} users");
                    } else if spike_applied
                        && elapsed >= spike_end_at
                        && current_users == spike_users
                    {
                        // Spike "ends" by ceasing to count the extra users.
                        // The actual workers stop only when total duration ends.
                        current_users = base_users;
                    }

                    let _ = self.update_tx.send(PerfUpdate::Progress {
                        metrics: snapshot,
                        current_users,
                        target_duration_ms: total_duration.as_millis() as u64,
                    }).await;
                }
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        for h in spike_handles { let _ = h.await; }
                        return Ok(true);
                    }
                }
                _ = sleep(Duration::from_millis(50)) => {
                    if start.elapsed() >= total_duration {
                        let _ = user_stop_tx.send(true);
                        for h in handles { let _ = h.await; }
                        for h in spike_handles { let _ = h.await; }
                        return Ok(false);
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_user(
        &self,
        request: HttpRequest,
        assertions: Vec<Assertion>,
        env_vars: HashMap<String, String>,
        extracted_vars: HashMap<String, String>,
        local_vars: HashMap<String, String>,
        sample_tx: mpsc::Sender<RequestSample>,
        stop_rx: watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        let executor = self.executor.clone();
        tokio::spawn(async move {
            loop {
                if *stop_rx.borrow() {
                    break;
                }
                let start = Instant::now();
                let result = executor
                    .execute(&request, &extracted_vars, &local_vars, &env_vars, &[])
                    .await;
                let duration = start.elapsed();
                let sample = sample_from_status(&result.status, duration, &assertions);
                if sample_tx.send(sample).await.is_err() {
                    break;
                }
                if stop_rx.has_changed().unwrap_or(true) && *stop_rx.borrow() {
                    break;
                }
            }
        })
    }
}

fn sample_from_status(
    status: &ExecutionStatus,
    duration: Duration,
    assertions: &[Assertion],
) -> RequestSample {
    match status {
        ExecutionStatus::Success { response } => {
            let assertions_passed = assertions
                .iter()
                .all(|a| a.evaluate(response, duration).passed);
            RequestSample {
                timestamp: Instant::now(),
                duration,
                status_code: response.status_code,
                size_bytes: response.size_bytes,
                success: response.is_success(),
                error_message: None,
                assertions_passed,
            }
        }
        ExecutionStatus::Error { message } => RequestSample {
            timestamp: Instant::now(),
            duration,
            status_code: 0,
            size_bytes: 0,
            success: false,
            error_message: Some(message.clone()),
            assertions_passed: false,
        },
        _ => RequestSample {
            timestamp: Instant::now(),
            duration,
            status_code: 0,
            size_bytes: 0,
            success: false,
            error_message: Some("request not completed".to_string()),
            assertions_passed: false,
        },
    }
}
