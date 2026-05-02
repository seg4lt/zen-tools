/**
 * Renders the list of CI check badges in the inline PR detail panel.
 * Uses shadcn Badge variants — colour comes from the theme tokens, not
 * hardcoded Tailwind palette steps.
 */

import { Check, CircleHelp, Clock, X } from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Badge } from "@/components/ui/badge";
import {
  checkDisplayName,
  checkKind,
  checkUrl,
  type CheckContext,
  type StatusCheckRollup,
} from "../../lib/tauri";

interface Props {
  rollup: StatusCheckRollup | null | undefined;
}

export function CiChecks({ rollup }: Props) {
  const checks = rollup?.contexts?.nodes ?? [];
  if (!rollup || checks.length === 0) {
    return (
      <span className="text-xs italic text-muted-foreground">No checks</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {checks.map((c, i) => (
        <CheckPill key={`${checkDisplayName(c)}-${i}`} c={c} />
      ))}
    </div>
  );
}

function CheckPill({ c }: { c: CheckContext }) {
  const kind = checkKind(c);
  const url = checkUrl(c);
  const label = checkDisplayName(c);
  const truncated = label.length > 30 ? `${label.slice(0, 27)}...` : label;
  const Icon =
    kind === "success"
      ? Check
      : kind === "pending"
        ? Clock
        : kind === "failed"
          ? X
          : CircleHelp;
  const variant =
    kind === "failed"
      ? "destructive"
      : kind === "success"
        ? "secondary"
        : "outline";

  const content = (
    <Badge variant={variant} className="gap-1">
      <Icon className="size-3" />
      {truncated}
    </Badge>
  );

  if (!url) return content;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url);
      }}
      title={`${label} — open`}
      className="cursor-pointer"
    >
      {content}
    </button>
  );
}
