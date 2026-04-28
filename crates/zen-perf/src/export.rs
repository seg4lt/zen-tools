//! CSV export and human-readable formatting for [`MetricsSnapshot`].

use crate::error::PerfError;
use crate::metrics::{MetricsSnapshot, RequestSample};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Write per-sample CSV rows.
pub fn export_samples_csv<W: Write>(
    writer: &mut W,
    samples: &[RequestSample],
    request_name: &str,
    test_start: Instant,
) -> Result<(), PerfError> {
    writeln!(
        writer,
        "timestamp_ms,request_name,duration_ms,status_code,size_bytes,success,assertions_passed,error_message"
    )?;

    for sample in samples {
        let timestamp_ms = sample.timestamp.duration_since(test_start).as_millis();
        writeln!(
            writer,
            "{},{},{},{},{},{},{},\"{}\"",
            timestamp_ms,
            request_name,
            sample.duration.as_millis(),
            sample.status_code,
            sample.size_bytes,
            sample.success,
            sample.assertions_passed,
            sample.error_message.as_deref().unwrap_or(""),
        )?;
    }
    Ok(())
}

/// Write a single-row summary CSV.
pub fn export_summary_csv<W: Write>(
    writer: &mut W,
    test_name: &str,
    metrics: &MetricsSnapshot,
) -> Result<(), PerfError> {
    writeln!(
        writer,
        "test_name,total_requests,successful,failed,assertion_failures,error_rate_pct,min_ms,max_ms,avg_ms,p50_ms,p95_ms,p99_ms,throughput_rps,total_bytes,duration_secs"
    )?;
    writeln!(
        writer,
        "{},{},{},{},{},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{:.2},{},{:.2}",
        test_name,
        metrics.total_requests,
        metrics.successful,
        metrics.failed,
        metrics.assertion_failures,
        metrics.error_rate_percent,
        metrics.latency_min_ms,
        metrics.latency_max_ms,
        metrics.latency_avg_ms,
        metrics.latency_p50_ms,
        metrics.latency_p95_ms,
        metrics.latency_p99_ms,
        metrics.throughput_rps,
        metrics.total_bytes,
        metrics.elapsed_ms as f64 / 1000.0,
    )?;
    Ok(())
}

/// Export both samples and summary to disk; returns `(samples_path, summary_path)`.
pub fn export_to_files(
    output_dir: &Path,
    test_name: &str,
    samples: &[RequestSample],
    metrics: &MetricsSnapshot,
    test_start: Instant,
) -> Result<(PathBuf, PathBuf), PerfError> {
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

    let samples_path = output_dir.join(format!("{safe_name}_{timestamp}_samples.csv"));
    let mut file = std::fs::File::create(&samples_path)?;
    export_samples_csv(&mut file, samples, test_name, test_start)?;

    let summary_path = output_dir.join(format!("{safe_name}_{timestamp}_summary.csv"));
    let mut file = std::fs::File::create(&summary_path)?;
    export_summary_csv(&mut file, test_name, metrics)?;

    Ok((samples_path, summary_path))
}

/// Format a metrics snapshot as a human-readable string for the CLI.
pub fn format_summary(test_name: &str, metrics: &MetricsSnapshot) -> String {
    format!(
        r#"
Performance Test Results: {test_name}
═══════════════════════════════════════════════════════════

Requests
  Total:        {:>10}
  Successful:   {:>10}
  Failed:       {:>10}
  Assert Fail:  {:>10}
  Error Rate:   {:>10.2}%

Latency (ms)
  Min:          {:>10.2}
  Max:          {:>10.2}
  Average:      {:>10.2}
  p50:          {:>10.2}
  p95:          {:>10.2}
  p99:          {:>10.2}

Throughput
  Requests/sec: {:>10.2}
  Bytes/sec:    {:>10.2}

Duration:       {:>10.2}s
Total Data:     {:>10} bytes
"#,
        metrics.total_requests,
        metrics.successful,
        metrics.failed,
        metrics.assertion_failures,
        metrics.error_rate_percent,
        metrics.latency_min_ms,
        metrics.latency_max_ms,
        metrics.latency_avg_ms,
        metrics.latency_p50_ms,
        metrics.latency_p95_ms,
        metrics.latency_p99_ms,
        metrics.throughput_rps,
        metrics.bytes_per_sec,
        metrics.elapsed_ms as f64 / 1000.0,
        metrics.total_bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_summary_csv() {
        let metrics = MetricsSnapshot {
            total_requests: 1000,
            successful: 990,
            failed: 10,
            assertion_failures: 5,
            error_rate_percent: 1.0,
            latency_min_ms: 10.0,
            latency_max_ms: 500.0,
            latency_avg_ms: 50.0,
            latency_p50_ms: 45.0,
            latency_p95_ms: 150.0,
            latency_p99_ms: 300.0,
            throughput_rps: 100.0,
            elapsed_ms: 10_000,
            total_bytes: 1_000_000,
            bytes_per_sec: 100_000.0,
            latency_history: vec![],
            throughput_history: vec![],
            latency_buckets: vec![],
        };
        let mut buf = Vec::new();
        export_summary_csv(&mut buf, "Test", &metrics).unwrap();
        let csv = String::from_utf8(buf).unwrap();
        assert!(csv.contains("test_name"));
        assert!(csv.contains("Test"));
        assert!(csv.contains("1000"));
    }
}
