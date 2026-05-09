/**
 * Header strip on the Merge tab — describes what op is in progress
 * and exposes Continue / Abort / Skip.
 */

import { GitMerge, Pause, Play, RotateCcw } from "lucide-react";
import { Button, cn } from "@zen-tools/ui";

import type { MergeKind, MergeState } from "../../lib/tauri";

const KIND_LABEL: Record<MergeKind, string> = {
  merge: "merge",
  rebase: "rebase",
  cherryPick: "cherry-pick",
  revert: "revert",
  none: "",
};

export interface MergeHeaderProps {
  state: MergeState;
  busy: boolean;
  onContinue: () => void;
  onAbort: () => void;
  onSkip: () => void;
  onPreview: () => void;
}

export function MergeHeader({
  state,
  busy,
  onContinue,
  onAbort,
  onSkip,
  onPreview,
}: MergeHeaderProps) {
  const idle = state.kind === "none";
  const skipSupported =
    state.kind === "rebase" ||
    state.kind === "cherryPick" ||
    state.kind === "revert";

  return (
    <header
      className={cn(
        "flex items-center gap-3 border-b px-4 py-2",
        !idle && state.unresolved > 0 && "bg-amber-500/10",
        !idle && state.unresolved === 0 && "bg-emerald-500/10",
      )}
    >
      <GitMerge className="h-4 w-4 text-muted-foreground" />
      <div className="flex-1 text-sm">
        {idle ? (
          <span className="text-muted-foreground">
            No merge, rebase, or cherry-pick in progress.
          </span>
        ) : (
          <span>
            <span className="font-medium capitalize">
              {KIND_LABEL[state.kind]}
            </span>{" "}
            in progress
            {state.incoming && (
              <>
                {" "}
                — incoming{" "}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  {state.incoming}
                </code>
              </>
            )}
            {state.head && (
              <>
                {" "}
                onto{" "}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  {state.head}
                </code>
              </>
            )}
            <span className="ml-2 text-xs text-muted-foreground">
              {state.unresolved} unresolved
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={onPreview}
          disabled={busy}
        >
          Preview merge…
        </Button>
        {!idle && (
          <>
            <Button
              size="sm"
              onClick={onContinue}
              disabled={busy || state.unresolved > 0}
              title={
                state.unresolved > 0
                  ? `Resolve ${state.unresolved} file(s) first`
                  : "Continue"
              }
            >
              <Play className="mr-1 h-3.5 w-3.5" /> Continue
            </Button>
            {skipSupported && (
              <Button
                size="sm"
                variant="outline"
                onClick={onSkip}
                disabled={busy}
              >
                <Pause className="mr-1 h-3.5 w-3.5" /> Skip
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={onAbort}
              disabled={busy}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Abort
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
