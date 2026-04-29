/**
 * Pure-SVG sparkline with a gradient area fill below the line.
 *
 * Port of `process-monitor/frontend/src/components/sparkline.rs`. Inline SVG
 * is deliberately preferred over `recharts` here — for 240×36 px sparklines
 * that redraw every second the polyline+polygon approach is dramatically
 * cheaper than re-issuing a Recharts `<LineChart>`.
 */

import { useId } from "react";

export interface SparklineProps {
  /** Value series, oldest first. */
  values: number[];
  /** Upper bound for normalisation. If unset, uses series max. */
  max?: number;
  /** Stroke + gradient color (CSS color string). */
  color?: string;
  width?: number;
  height?: number;
}

export function Sparkline({
  values,
  max,
  color = "var(--accent, #60a5fa)",
  width = 240,
  height = 36,
}: SparklineProps) {
  const gradId = useId();
  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="sparkline-svg"
      />
    );
  }

  const upper =
    max && max > 0 ? max : Math.max(1, ...values.map((v) => (Number.isFinite(v) ? v : 0)));
  const n = values.length;
  const step = n > 1 ? width / (n - 1) : 0;
  const pts = values.map((v, i) => {
    const x = i * step;
    const ratio = Math.min(1, Math.max(0, v / upper));
    const y = height - ratio * (height - 3) - 1.5;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area =
    first && last
      ? `${first[0].toFixed(1)},${height.toFixed(1)} ${line} ${last[0].toFixed(
          1,
        )},${height.toFixed(1)}`
      : "";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="sparkline-svg"
      style={{ width: "100%", height }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradId})`} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
