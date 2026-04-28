import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

interface PerfSparklineProps {
  /** `(x, y)` pairs as emitted by the Rust collector. */
  series: [number, number][];
  /** CSS color to use for the line/fill. */
  color?: string;
  /** Optional unit suffix shown in the tooltip area. */
  unit?: string;
  /** Override the chart height in px. Defaults to 80. */
  height?: number;
  /** Optional title shown above the chart. */
  title?: string;
}

/** Tiny area chart for latency / throughput rolling histories. */
export function PerfSparkline({
  series,
  color = "var(--color-primary)",
  unit,
  height = 80,
  title,
}: PerfSparklineProps) {
  const data = useMemo(
    () => series.map(([x, y]) => ({ x, y })),
    [series],
  );

  const max = data.reduce((m, p) => (p.y > m ? p.y : m), 0);

  return (
    <div className="flex flex-col gap-1">
      {title && (
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{title}</span>
          <span className="tabular-nums">
            {max.toFixed(1)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      )}
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>
          <AreaChart
            data={data}
            margin={{ top: 4, bottom: 0, left: 0, right: 0 }}
          >
            <defs>
              <linearGradient id={`grad-${title ?? "spark"}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, "dataMax"]} />
            <Area
              type="monotone"
              dataKey="y"
              stroke={color}
              fill={`url(#grad-${title ?? "spark"})`}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
