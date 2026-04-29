/**
 * Formatting helpers for the Process Monitor UI. Mirrors the original
 * `frontend/src/util.rs` helpers byte-for-byte so the displayed values
 * match Activity Monitor.
 */

export function fmtBytes(b: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (b >= GB) return `${(b / GB).toFixed(2)} GB`;
  if (b >= MB) return `${(b / MB).toFixed(1)} MB`;
  if (b >= KB) return `${(b / KB).toFixed(0)} KB`;
  return `${b} B`;
}

export function fmtCpu(pct: number): string {
  return pct >= 100 ? `${pct.toFixed(0)} %` : `${pct.toFixed(1)} %`;
}

/** Pick a text colour for a CPU% reading (matches the source's severity bands). */
export function cpuSeverity(pct: number): string {
  if (pct < 25) return "var(--good, #22c55e)";
  if (pct < 75) return "var(--warn, #eab308)";
  if (pct < 200) return "var(--hot, #f97316)";
  return "var(--bad, #ef4444)";
}
