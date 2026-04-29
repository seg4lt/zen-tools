import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MetricsSnapshot } from "../lib/perf-types";

interface PerfCountersProps {
  metrics: MetricsSnapshot;
  currentUsers?: number;
}

interface CounterCard {
  label: string;
  value: string;
  tone?: "destructive" | "warning";
}

/**
 * Headline counter grid — total / RPS / errors / p99 / users / bytes.
 * Quiet by design: no left accent bars, no chart-color tinting. Just
 * the number, the label, and a tone change when an error rate is
 * non-zero.
 */
export function PerfCounters({ metrics, currentUsers }: PerfCountersProps) {
  const cards: CounterCard[] = [
    {
      label: "Total requests",
      value: metrics.totalRequests.toLocaleString(),
    },
    {
      label: "Requests / sec",
      value: metrics.throughputRps.toFixed(1),
    },
    {
      label: "Error rate",
      value: `${metrics.errorRatePercent.toFixed(1)}%`,
      tone:
        metrics.errorRatePercent > 5
          ? "destructive"
          : metrics.errorRatePercent > 0
            ? "warning"
            : undefined,
    },
    {
      label: "P99 latency",
      value: `${metrics.latencyP99Ms.toFixed(0)}ms`,
    },
    {
      label: "Users",
      value: currentUsers != null ? currentUsers.toString() : "—",
    },
    {
      label: "Bytes / sec",
      value: formatBytes(metrics.bytesPerSec),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((c) => (
        <Card
          key={c.label}
          className="border bg-card/40 shadow-none"
        >
          <CardContent className="flex flex-col gap-0.5 p-3">
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums leading-tight",
                c.tone === "destructive" && "text-destructive",
                c.tone === "warning" && "text-amber-500",
              )}
            >
              {c.value}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {c.label}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
