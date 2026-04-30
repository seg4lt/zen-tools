/**
 * Bottom sheet that slides in once a bulk run completes.
 *
 * Shows the success / failure groups, with each failure expandable
 * to its error message. Dismissing the sheet returns the run state
 * to `idle`.
 */

import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCleanerStore } from "../store/cleaner-store";

export function ResultsSheet() {
  const { state, dispatch } = useCleanerStore();
  const open = state.runState === "done" && state.results !== null;
  const results = state.results;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) dispatch({ type: "dismissResults" });
      }}
    >
      <SheetContent
        side="bottom"
        className="max-h-[60vh] gap-0"
        showCloseButton
      >
        <SheetHeader className="border-b">
          <SheetTitle>Cleanup results</SheetTitle>
          <SheetDescription>
            {results
              ? `${results.successes.length} succeeded · ${results.failures.length} failed`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
          <section>
            <h3 className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <CheckCircle2 className="size-3 text-emerald-500" />
              Succeeded ({results?.successes.length ?? 0})
            </h3>
            {results && results.successes.length > 0 ? (
              <ul className="divide-y divide-border/40 rounded-md border bg-emerald-500/5 font-mono text-[11px]">
                {results.successes.map((s) => (
                  <li key={s} className="px-2 py-1">
                    {s}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing succeeded.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <XCircle className="size-3 text-destructive" />
              Failed ({results?.failures.length ?? 0})
            </h3>
            {results && results.failures.length > 0 ? (
              <ul className="divide-y divide-border/40 rounded-md border bg-destructive/5 font-mono text-[11px]">
                {results.failures.map((f) => (
                  <li key={f.item} className="flex flex-col gap-0.5 px-2 py-1.5">
                    <span>{f.item}</span>
                    <span className="text-[10px] text-muted-foreground/80">
                      {f.error}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No failures 🎉</p>
            )}
          </section>
        </div>

        <SheetFooter className="border-t">
          <Button onClick={() => dispatch({ type: "dismissResults" })}>
            Dismiss
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
