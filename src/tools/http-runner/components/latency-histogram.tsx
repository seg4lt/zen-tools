import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@zen-tools/ui";

interface LatencyHistogramProps {
  buckets: [string, number][];
}

const config = {
  value: {
    label: "Share",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

/**
 * Bar chart of the latency distribution buckets (`0–50ms`, `50–100ms`,
 * …). Uses the shadcn `<ChartContainer>` so the tooltip card and grid
 * styling match the rest of the app's design system.
 */
export function LatencyHistogram({ buckets }: LatencyHistogramProps) {
  const data = useMemo(
    () => buckets.map(([name, value]) => ({ name, value })),
    [buckets],
  );
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card/40 p-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-muted-foreground">
          Latency distribution
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {buckets.length} buckets
        </span>
      </div>
      <ChartContainer
        config={config}
        className="aspect-auto h-44 w-full"
      >
        <BarChart
          data={data}
          margin={{ top: 16, right: 8, bottom: 0, left: -16 }}
        >
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke="var(--color-border)"
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            width={32}
            tickFormatter={(v) => `${v}%`}
          />
          <ChartTooltip
            cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {item?.payload?.name}
                    </span>
                    <span className="font-mono tabular-nums">
                      {Number(value).toFixed(1)}%
                    </span>
                  </div>
                )}
              />
            }
          />
          <Bar
            dataKey="value"
            fill="var(--color-chart-1)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="value"
              position="top"
              className="fill-muted-foreground"
              fontSize={9}
              formatter={(v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 1 ? `${n.toFixed(0)}%` : "";
              }}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}
