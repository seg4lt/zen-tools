/**
 * Shared avatar for PRMaster — used by the hero header and the
 * reviewer chips. Renders the GitHub `avatars.githubusercontent.com`
 * thumbnail when a `login` is present, or a deterministic colored
 * initial fallback when it isn't.
 *
 * An optional `dot` overlay paints a tiny status circle at the
 * bottom-right (used to encode reviewer state — APPROVED / CHANGES /
 * COMMENTED / PENDING — without taking up a separate text chunk).
 */

import { cn } from "@zen-tools/ui";

export type AvatarDotTone =
  | "success" // approved
  | "danger" // changes requested
  | "warning" // commented
  | "muted"; // pending / no review yet

interface Props {
  login: string;
  size?: number;
  dot?: AvatarDotTone | null;
  className?: string;
  title?: string;
}

export function Avatar({
  login,
  size = 22,
  dot = null,
  className,
  title,
}: Props) {
  const initial = (login || "?").charAt(0).toUpperCase();
  const hue = stringHue(login);
  const tip = title ?? (login ? `@${login}` : undefined);
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      title={tip}
    >
      {login ? (
        <img
          src={`https://avatars.githubusercontent.com/${encodeURIComponent(
            login,
          )}?size=${size * 2}`}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          className="inline-flex shrink-0 select-none overflow-hidden rounded-full bg-muted ring-1 ring-border/50"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="inline-flex shrink-0 select-none items-center justify-center rounded-full text-[9px] font-semibold uppercase"
          style={{
            width: size,
            height: size,
            backgroundColor: `oklch(0.85 0.06 ${hue})`,
            color: `oklch(0.25 0.05 ${hue})`,
          }}
        >
          {initial}
        </span>
      )}
      {dot && <StatusDot tone={dot} />}
    </span>
  );
}

function StatusDot({ tone }: { tone: AvatarDotTone }) {
  const color: Record<AvatarDotTone, string> = {
    success: "bg-emerald-500",
    danger: "bg-destructive",
    warning: "bg-amber-500",
    muted: "bg-muted-foreground/60",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card",
        color[tone],
      )}
    />
  );
}

function stringHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
