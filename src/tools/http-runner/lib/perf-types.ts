/**
 * TypeScript shapes for `perf:update` event payloads. Mirrors the Rust
 * PerfUpdate enum + the MetricsSnapshot DTO.
 */

export interface MetricsSnapshot {
  totalRequests: number;
  successful: number;
  failed: number;
  assertionFailures: number;
  errorRatePercent: number;
  latencyMinMs: number;
  latencyMaxMs: number;
  latencyAvgMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  throughputRps: number;
  elapsedMs: number;
  totalBytes: number;
  bytesPerSec: number;
  latencyHistory: [number, number][];
  throughputHistory: [number, number][];
  latencyBuckets: [string, number][];
}

export type PerfUpdate =
  | { type: "started"; testName: string }
  | {
      type: "progress";
      metrics: MetricsSnapshot;
      currentUsers: number;
      targetDurationMs: number;
    }
  | { type: "completed"; testName: string; finalMetrics: MetricsSnapshot }
  | { type: "stopped"; testName: string; finalMetrics: MetricsSnapshot }
  | { type: "error"; testName: string; message: string };

export interface PerfTestDto {
  name: string;
  request: string;
  testType: { type: string } & Record<string, unknown>;
  maxUsers: number;
  totalDurationMs: number;
  targetRps: number | null;
}

export interface PerfConfigDto {
  path: string;
  tests: PerfTestDto[];
}
