//! HDR-histogram-based metrics collector for the perf engine.

use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// One observation captured by a worker task.
///
/// `timestamp` is a [`std::time::Instant`] (non-serialisable) — these
/// samples never cross the IPC boundary; only the aggregated
/// [`MetricsSnapshot`] does.
#[derive(Debug, Clone)]
pub struct RequestSample {
    /// Wall-clock instant when the request finished.
    pub timestamp: Instant,
    /// Round-trip duration.
    pub duration: Duration,
    /// HTTP status code (0 for transport errors).
    pub status_code: u16,
    /// Body size in bytes.
    pub size_bytes: usize,
    /// `true` for transport-success + 2xx response.
    pub success: bool,
    /// Optional transport-level error.
    pub error_message: Option<String>,
    /// `true` if all `# @assert` assertions passed.
    pub assertions_passed: bool,
}

/// Streaming metrics collector. Stores raw samples for CSV export and uses
/// an HDR Histogram for fast percentiles.
pub struct MetricsCollector {
    samples: Vec<RequestSample>,
    latency: Histogram<u64>,
    start_time: Instant,
    successful: u64,
    failed: u64,
    assertion_failures: u64,
    total_bytes: u64,
    latency_history: VecDeque<f64>,
    throughput_history: VecDeque<f64>,
    last_snapshot_at: Instant,
    requests_since_snapshot: u64,
    latency_sum_since_snapshot: u64,
    max_history: usize,
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsCollector {
    /// New collector with the standard histogram bounds (1µs – 10min, 3 sig
    /// figs).
    pub fn new() -> Self {
        Self {
            samples: Vec::new(),
            latency: Histogram::new_with_bounds(1, 600_000_000, 3)
                .expect("failed to construct latency histogram"),
            start_time: Instant::now(),
            successful: 0,
            failed: 0,
            assertion_failures: 0,
            total_bytes: 0,
            latency_history: VecDeque::with_capacity(60),
            throughput_history: VecDeque::with_capacity(60),
            last_snapshot_at: Instant::now(),
            requests_since_snapshot: 0,
            latency_sum_since_snapshot: 0,
            max_history: 60,
        }
    }

    /// Reset for a new test run.
    pub fn reset(&mut self) {
        self.samples.clear();
        self.latency.reset();
        self.start_time = Instant::now();
        self.successful = 0;
        self.failed = 0;
        self.assertion_failures = 0;
        self.total_bytes = 0;
        self.latency_history.clear();
        self.throughput_history.clear();
        self.last_snapshot_at = Instant::now();
        self.requests_since_snapshot = 0;
        self.latency_sum_since_snapshot = 0;
    }

    /// Record one sample.
    pub fn record(&mut self, sample: RequestSample) {
        let latency_us = sample.duration.as_micros() as u64;
        let _ = self.latency.record(latency_us.max(1));

        if sample.success {
            self.successful += 1;
        } else {
            self.failed += 1;
        }
        if !sample.assertions_passed {
            self.assertion_failures += 1;
        }
        self.total_bytes += sample.size_bytes as u64;

        self.requests_since_snapshot += 1;
        self.latency_sum_since_snapshot += latency_us;

        self.samples.push(sample);
    }

    /// Push a 1-second window into the rolling history if a second has
    /// elapsed since the last call.
    pub fn update_history(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_snapshot_at).as_secs_f64();
        if elapsed < 1.0 {
            return;
        }

        let throughput = self.requests_since_snapshot as f64 / elapsed;
        self.throughput_history.push_back(throughput);
        if self.throughput_history.len() > self.max_history {
            self.throughput_history.pop_front();
        }

        let avg_latency_ms = if self.requests_since_snapshot > 0 {
            (self.latency_sum_since_snapshot as f64 / self.requests_since_snapshot as f64) / 1000.0
        } else {
            0.0
        };
        self.latency_history.push_back(avg_latency_ms);
        if self.latency_history.len() > self.max_history {
            self.latency_history.pop_front();
        }

        self.last_snapshot_at = now;
        self.requests_since_snapshot = 0;
        self.latency_sum_since_snapshot = 0;
    }

    /// Compute a snapshot.
    pub fn snapshot(&self) -> MetricsSnapshot {
        let total = self.successful + self.failed;
        let elapsed = self.start_time.elapsed();
        let elapsed_secs = elapsed.as_secs_f64().max(0.001);

        let latency_min_ms = self.latency.min() as f64 / 1000.0;
        let latency_max_ms = self.latency.max() as f64 / 1000.0;
        let latency_avg_ms = self.latency.mean() / 1000.0;
        let latency_p50_ms = self.latency.value_at_quantile(0.50) as f64 / 1000.0;
        let latency_p95_ms = self.latency.value_at_quantile(0.95) as f64 / 1000.0;
        let latency_p99_ms = self.latency.value_at_quantile(0.99) as f64 / 1000.0;

        let error_rate_percent = if total > 0 {
            (self.failed as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        let latency_history: Vec<(f64, f64)> = self
            .latency_history
            .iter()
            .enumerate()
            .map(|(i, &y)| (i as f64, y))
            .collect();
        let throughput_history: Vec<(f64, f64)> = self
            .throughput_history
            .iter()
            .enumerate()
            .map(|(i, &y)| (i as f64, y))
            .collect();

        MetricsSnapshot {
            total_requests: total,
            successful: self.successful,
            failed: self.failed,
            assertion_failures: self.assertion_failures,
            error_rate_percent,
            latency_min_ms,
            latency_max_ms,
            latency_avg_ms,
            latency_p50_ms,
            latency_p95_ms,
            latency_p99_ms,
            throughput_rps: total as f64 / elapsed_secs,
            elapsed_ms: elapsed.as_millis() as u64,
            total_bytes: self.total_bytes,
            bytes_per_sec: self.total_bytes as f64 / elapsed_secs,
            latency_history,
            throughput_history,
            latency_buckets: self.latency_buckets(),
        }
    }

    fn latency_buckets(&self) -> Vec<(String, f64)> {
        const BUCKETS: &[(&str, u64, u64)] = &[
            ("<50ms", 0, 50_000),
            ("<100ms", 50_000, 100_000),
            ("<200ms", 100_000, 200_000),
            ("<500ms", 200_000, 500_000),
            ("500ms+", 500_000, u64::MAX),
        ];

        let total = self.latency.len() as f64;
        if total == 0.0 {
            return BUCKETS
                .iter()
                .map(|(label, _, _)| ((*label).to_string(), 0.0))
                .collect();
        }

        BUCKETS
            .iter()
            .map(|(label, low, high)| {
                let count: u64 = self
                    .latency
                    .iter_recorded()
                    .filter(|v| v.value_iterated_to() >= *low && v.value_iterated_to() < *high)
                    .map(|v| v.count_at_value())
                    .sum();
                ((*label).to_string(), (count as f64 / total) * 100.0)
            })
            .collect()
    }

    /// Borrow the recorded sample buffer (CSV export uses this).
    pub fn samples(&self) -> &[RequestSample] {
        &self.samples
    }

    /// `successful + failed`.
    pub fn total_requests(&self) -> u64 {
        self.successful + self.failed
    }

    /// Test start time (for sample timestamp arithmetic during export).
    pub fn start_time(&self) -> Instant {
        self.start_time
    }
}

/// Aggregate metrics snapshot. Crosses the IPC boundary as JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    /// Total requests so far.
    pub total_requests: u64,
    /// Transport + 2xx successes.
    pub successful: u64,
    /// Transport failures or non-2xx.
    pub failed: u64,
    /// Requests where at least one assertion failed.
    pub assertion_failures: u64,
    /// `failed / total_requests * 100`.
    pub error_rate_percent: f64,

    /// Latency floor (ms).
    pub latency_min_ms: f64,
    /// Latency ceiling (ms).
    pub latency_max_ms: f64,
    /// Mean latency (ms).
    pub latency_avg_ms: f64,
    /// 50th percentile (ms).
    pub latency_p50_ms: f64,
    /// 95th percentile (ms).
    pub latency_p95_ms: f64,
    /// 99th percentile (ms).
    pub latency_p99_ms: f64,

    /// Requests per second.
    pub throughput_rps: f64,
    /// Test elapsed time, in milliseconds (Duration is not portable JSON).
    pub elapsed_ms: u64,

    /// Total bytes received.
    pub total_bytes: u64,
    /// Bytes per second.
    pub bytes_per_sec: f64,

    /// Rolling 1-second windows: `(index, ms)`.
    pub latency_history: Vec<(f64, f64)>,
    /// Rolling 1-second windows: `(index, rps)`.
    pub throughput_history: Vec<(f64, f64)>,
    /// `(label, percent)` pairs for the histogram bar chart.
    pub latency_buckets: Vec<(String, f64)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_records_and_snapshots() {
        let mut c = MetricsCollector::new();
        for i in 0..100 {
            c.record(RequestSample {
                timestamp: Instant::now(),
                duration: Duration::from_millis(10 + i),
                status_code: 200,
                size_bytes: 1000,
                success: true,
                error_message: None,
                assertions_passed: true,
            });
        }
        let s = c.snapshot();
        assert_eq!(s.total_requests, 100);
        assert_eq!(s.successful, 100);
        assert!(s.latency_avg_ms > 0.0);
        assert!(s.latency_p95_ms >= s.latency_p50_ms);
    }

    #[test]
    fn error_rate_is_correct() {
        let mut c = MetricsCollector::new();
        for _ in 0..90 {
            c.record(RequestSample {
                timestamp: Instant::now(),
                duration: Duration::from_millis(50),
                status_code: 200,
                size_bytes: 100,
                success: true,
                error_message: None,
                assertions_passed: true,
            });
        }
        for _ in 0..10 {
            c.record(RequestSample {
                timestamp: Instant::now(),
                duration: Duration::from_millis(50),
                status_code: 500,
                size_bytes: 0,
                success: false,
                error_message: Some("err".into()),
                assertions_passed: false,
            });
        }
        let s = c.snapshot();
        assert!((s.error_rate_percent - 10.0).abs() < 0.1);
    }
}
