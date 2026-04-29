import { PerfCounters } from "./perf-counters";
import { PerfSparkline } from "./perf-sparkline";
import { LatencyHistogram } from "./latency-histogram";
import type { MetricsSnapshot } from "../lib/perf-types";

interface PerfDashboardProps {
  metrics: MetricsSnapshot | null;
  currentUsers: number | undefined;
  exportToast: string | null;
}

/**
 * Live perf-test dashboard rendered below the editor when the user
 * opens a `.perf.yaml` file. Mirrors the slot a `ResponsePanel` fills
 * for `.http` files, so the unified Requests view doesn't need a
 * separate Performance tab.
 */
export function PerfDashboard({
  metrics,
  currentUsers,
  exportToast,
}: PerfDashboardProps) {
  if (!metrics) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        Pick a perf test on the left and run it to see live metrics.
      </div>
    );
  }
  return (
    // `h-full` (not `flex-1`) — PaneFrame's body is a plain block, so
    // `flex-1` does nothing and the dashboard renders at its natural
    // height which the parent then `overflow-hidden`-clips. `h-full`
    // inherits the parent's flex-allocated height, then `min-h-0` +
    // `overflow-y-auto` give us a real scroll container.
    <div className="relative flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <PerfCounters metrics={metrics} currentUsers={currentUsers} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <PerfSparkline
          title="Throughput (req/s)"
          series={metrics.throughputHistory}
          colorVar="chart-1"
          unit="req/s"
        />
        <PerfSparkline
          title="Latency avg (ms)"
          series={metrics.latencyHistory}
          colorVar="chart-2"
          unit="ms"
        />
      </div>
      <LatencyHistogram buckets={metrics.latencyBuckets} />
      {exportToast && (
        <div className="absolute bottom-3 right-3 max-w-sm rounded-md border bg-card px-3 py-2 text-xs shadow-lg">
          <div className="font-medium">Exported</div>
          <div className="break-all font-mono text-[10px] text-muted-foreground">
            {exportToast}
          </div>
        </div>
      )}
    </div>
  );
}
