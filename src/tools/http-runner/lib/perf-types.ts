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

export type TestTypeKind =
  | "atomic"
  | "concurrent"
  | "stress"
  | "spike"
  | "soak";

export interface PerfTestDto {
  name: string;
  request: string;
  /**
   * Test discriminator. The Rust DTO intentionally only ships the tag
   * (the type-specific config is what actually drives the runner and
   * is summarised through `maxUsers` / `totalDurationMs` / `rampUpMs`
   * / `targetRps` on this same object).
   */
  testType: { type: TestTypeKind };
  maxUsers: number;
  totalDurationMs: number;
  rampUpMs: number;
  targetRps: number | null;
}

export interface PerfConfigDto {
  path: string;
  tests: PerfTestDto[];
}
