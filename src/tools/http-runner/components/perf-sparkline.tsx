import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@zen-tools/ui";

type ChartColorVar =
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5";

interface PerfSparklineProps {
  /** `(x, y)` pairs as emitted by the Rust collector. */
  series: [number, number][];
  /** Which `--chart-N` token to colour the line/fill with. */
  colorVar?: ChartColorVar;
  /** Optional unit suffix shown in the tooltip + last-value pill. */
  unit?: string;
  /** Override the chart height in px. Defaults to 140. */
  height?: number;
  /** Title shown above the chart. */
  title: string;
}

/**
 * Themed area chart using shadcn's `<ChartContainer>`. Reads the
 * `--color-chart-N` token (so it adapts to dark/light + theme tweaks
 * without prop changes) and renders a gradient fill, dashed grid,
 * and a shadcn-styled tooltip.
 */
export function PerfSparkline({
  series,
  colorVar = "chart-1",
  unit,
  height = 140,
  title,
}: PerfSparklineProps) {
  const data = useMemo(
    () => series.map(([x, y]) => ({ x, y })),
    [series],
  );
  const last = data.length > 0 ? data[data.length - 1].y : 0;

  // Two sparklines render side-by-side, so each `<linearGradient>` id
  // must be unique — collisions would make one chart fill solid.
  const gradId = `perf-spark-grad-${colorVar}`;

  const config = {
    y: {
      label: title,
      color: `var(--color-${colorVar})`,
    },
  } satisfies ChartConfig;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card/40 p-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-muted-foreground">{title}</span>
        <span className="font-mono tabular-nums text-foreground">
          {last.toFixed(1)}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height }}
      >
        <AreaChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={`var(--color-${colorVar})`}
                stopOpacity={0.7}
              />
              <stop
                offset="100%"
                stopColor={`var(--color-${colorVar})`}
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke="var(--color-border)"
          />
          <XAxis dataKey="x" hide />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            width={44}
            // Pad the top by ~10% so the line never hugs the ceiling
            // (looks broken when latency is essentially flat at e.g.
            // 0.4ms — the line would draw exactly at YAxis max).
            domain={[0, (dataMax: number) => (dataMax > 0 ? dataMax * 1.15 : 1)]}
            tickFormatter={formatYTick}
          />
          <ChartTooltip
            cursor={{
              stroke: "var(--color-border)",
              strokeDasharray: "3 3",
            }}
            content={
              <ChartTooltipContent
                indicator="dot"
                hideLabel
                formatter={(value) => (
                  <span className="font-mono tabular-nums">
                    {Number(value).toFixed(2)}
                    {unit ? ` ${unit}` : ""}
                  </span>
                )}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={`var(--color-${colorVar})`}
            fill={`url(#${gradId})`}
            strokeWidth={2.25}
            dot={false}
            activeDot={{
              r: 3,
              stroke: `var(--color-${colorVar})`,
              strokeWidth: 2,
              fill: "var(--color-background)",
            }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}

/**
 * Format a Y-axis tick. Sub-millisecond values keep two decimals so
 * `0.41ms` stays distinguishable from `0.5ms`; large numbers drop the
 * decimal entirely so labels stay short.
 */
function formatYTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
