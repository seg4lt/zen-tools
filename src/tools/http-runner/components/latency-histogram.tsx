import { useMemo } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";

interface LatencyHistogramProps {
  buckets: [string, number][];
}

/** Bar chart showing the latency distribution buckets (0–50ms, 50–100, …). */
export function LatencyHistogram({ buckets }: LatencyHistogramProps) {
  const data = useMemo(
    () => buckets.map(([name, value]) => ({ name, value })),
    [buckets],
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground">Latency distribution</div>
      <div style={{ width: "100%", height: 130 }}>
        <ResponsiveContainer>
          <BarChart
            data={data}
            margin={{ top: 4, right: 4, bottom: 0, left: -10 }}
          >
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                fontSize: 11,
              }}
              formatter={(value) => [
                `${Number(value).toFixed(1)}%`,
                "Share",
              ]}
              labelStyle={{ color: "var(--color-foreground)" }}
            />
            <Bar
              dataKey="value"
              fill="var(--color-primary)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
