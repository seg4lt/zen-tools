/**
 * Run-time prompt for `:name` placeholder values.
 *
 * Triggered by `DatabaseExplorerView` when a user-initiated run hits
 * SQL whose body contains placeholders. Renders one labelled input
 * per unique name (in first-appearance order), pre-filled from the
 * connection-scoped session memory in
 * `state.placeholderValuesByConnection`.
 *
 * UX rules:
 *   - Enter (in any field) submits.
 *   - Esc / overlay click cancels — the run does NOT fire.
 *   - Empty strings are allowed (substituted verbatim — sometimes
 *     what the user wants for a `''` literal).
 *   - The first input auto-focuses on open so the user can start
 *     typing immediately.
 *   - Values are inserted **verbatim** at substitution time. The
 *     dialog's hint copy reminds the user to add their own quotes
 *     for string literals.
 */

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@zen-tools/ui";

export interface PlaceholderDialogProps {
  /** When non-null, the dialog is open. Caller controls lifecycle. */
  prompt: {
    /** Unique placeholder names in first-appearance order. */
    names: string[];
    /**
     * Initial value per name. Names not present here render as
     * empty inputs. The dialog never mutates this object — it
     * keeps its own local state and only emits on submit.
     */
    seed: Record<string, string>;
  } | null;
  /** Submit. Called with the user-entered values keyed by name. */
  onSubmit: (values: Record<string, string>) => void;
  /** Esc, overlay click, or close button — fires the cancellation. */
  onCancel: () => void;
}

export function PlaceholderDialog({
  prompt,
  onSubmit,
  onCancel,
}: PlaceholderDialogProps) {
  // Local copy of the seed so the user's typing doesn't immediately
  // overwrite the session memory — that only happens on submit.
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  // Re-seed whenever a new prompt opens (different name set OR a
  // re-run of the same query with refreshed memory).
  useEffect(() => {
    if (!prompt) return;
    const next: Record<string, string> = {};
    for (const name of prompt.names) {
      next[name] = prompt.seed[name] ?? "";
    }
    setValues(next);
  }, [prompt]);

  // Auto-focus the first input on open. Defer one tick so Radix's
  // mount transition doesn't race the focus call.
  useEffect(() => {
    if (!prompt) return;
    const t = window.setTimeout(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [prompt]);

  if (!prompt) return null;

  const submit = () => {
    // Snapshot the current values into a plain object — `setValues`
    // is async and we want the values the user sees right now.
    const snapshot: Record<string, string> = {};
    for (const name of prompt.names) {
      snapshot[name] = values[name] ?? "";
    }
    onSubmit(snapshot);
  };

  return (
    <Dialog
      open
      // Radix fires `onOpenChange(false)` for Esc, overlay click,
      // and the close-X button. All three should cancel the run.
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        // Compact, bounded layout:
        //   • `max-h-[80vh]` so a query with dozens of placeholders
        //     can't push the dialog off-screen — the inputs scroll
        //     inside `flex-1 overflow-y-auto` below.
        //   • `flex flex-col` + `p-4 gap-3` overrides the primitive's
        //     looser defaults (`p-6 gap-4`) so header/inputs/footer
        //     sit closer together.
        //   • `sm:max-w-md` keeps the width tight.
        className="flex max-h-[80vh] flex-col gap-3 p-4 sm:max-w-md"
        onKeyDown={(e) => {
          // Submit on Enter from any input. Stops the keydown from
          // bubbling to CodeMirror underneath the modal — without
          // this, a stray Enter could insert a newline into the
          // editor buffer when the dialog closes.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogHeader className="gap-1">
          <DialogTitle className="text-sm">Query parameters</DialogTitle>
          <DialogDescription className="text-[11px]">
            Values are substituted verbatim — add your own quotes for
            string literals (e.g. <code>&apos;aman&apos;</code>).
          </DialogDescription>
        </DialogHeader>

        <form
          // The form scrolls when there are too many fields to fit
          // in the dialog's max-height. `min-h-0` is the
          // "flex-shrink lets you scroll" idiom — without it the
          // child `overflow-y-auto` never engages.
          className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {prompt.names.map((name, idx) => (
            <div
              key={name}
              className="grid grid-cols-[100px_1fr] items-center gap-2"
            >
              <Label
                htmlFor={`placeholder-${name}`}
                className="truncate font-mono text-[11px]"
                title={`:${name}`}
              >
                :{name}
              </Label>
              <Input
                id={`placeholder-${name}`}
                ref={idx === 0 ? firstInputRef : undefined}
                value={values[name] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [name]: e.target.value }))
                }
                autoComplete="off"
                spellCheck={false}
                className="h-7 px-2 py-0 font-mono text-xs"
              />
            </div>
          ))}
          {/* Hidden submit lets Enter trigger the form even when
              focus is in an Input that isn't wired to its own
              keypress handler. The container's onKeyDown above is
              the explicit path; this is a safety net for browsers
              that suppress implicit submission. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={onCancel}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={submit}
            className="h-7 text-xs"
          >
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
