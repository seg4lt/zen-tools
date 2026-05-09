/**
 * Small date / string helpers for the Git tool — relative-time
 * "2h ago", short ISO display, file-status color classes, etc.
 */

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/** Format a unix timestamp (seconds) as "2h ago" / "in 3 days". */
export function relativeTime(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = unixSec - now;
  const abs = Math.abs(delta);
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === "second") {
      return RTF.format(Math.round(delta / secs), unit);
    }
  }
  return "just now";
}

/** Format a unix timestamp (seconds) as ISO `YYYY-MM-DD HH:mm`. */
export function shortIso(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tailwind class for the colored letter chip on a file change status. */
export function statusColor(status: string): string {
  switch (status) {
    case "A":
      return "text-emerald-500";
    case "D":
      return "text-rose-500";
    case "M":
      return "text-amber-500";
    case "R":
    case "C":
      return "text-sky-500";
    default:
      return "text-muted-foreground";
  }
}

/** Pretty repo name from an absolute path — basename only. */
export function repoBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
