/**
 * "Preview merge X into Y" dialog. Backed by `git merge-tree
 * --write-tree` — performs the trial merge in-memory and reports
 * conflicts without touching the worktree, so users can sanity-check
 * before kicking off the real `git merge`.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zen-tools/ui";

import {
  gitTauri,
  type BranchRef,
  type MergePreview,
} from "../../lib/tauri";

export interface PreMergePreviewDialogProps {
  repo: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PreMergePreviewDialog({
  repo,
  open,
  onOpenChange,
}: PreMergePreviewDialogProps) {
  const [branches, setBranches] = useState<BranchRef[]>([]);
  const [into, setInto] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await gitTauri.listBranches(repo);
        if (cancelled) return;
        setBranches(list);
        const head = list.find((b) => b.isHead);
        setInto(head?.name ?? list[0]?.name ?? "");
        setFrom("");
        setPreview(null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repo]);

  const runPreview = async () => {
    if (!into || !from) return;
    setLoading(true);
    setError(null);
    try {
      const p = await gitTauri.previewMerge(repo, into, from);
      setPreview(p);
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview merge</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Merge from
            </label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="branch…" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.fullName} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="pb-2 text-xs text-muted-foreground">into</span>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Target
            </label>
            <Select value={into} onValueChange={setInto}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="branch…" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.fullName} value={b.name}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-600">
            {error}
          </div>
        )}

        {preview && (
          <div className="space-y-3 text-xs">
            <div>
              <span
                className={
                  preview.fastForward ? "text-emerald-600" : "text-amber-600"
                }
              >
                {preview.fastForward
                  ? "✓ Fast-forward possible"
                  : "↗ Three-way merge will create a merge commit"}
              </span>
              <span className="ml-2 text-muted-foreground">
                {preview.incomingCommits.length} new commit(s),{" "}
                {preview.filesChanged.length} file(s) changed
              </span>
            </div>
            {preview.conflicts.length > 0 ? (
              <div>
                <div className="mb-1 font-semibold text-amber-600">
                  Predicted conflicts ({preview.conflicts.length}):
                </div>
                <ul className="max-h-32 list-disc overflow-auto pl-5">
                  {preview.conflicts.map((c) => (
                    <li key={c} className="font-mono">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-emerald-600">No conflicts predicted.</div>
            )}
            {preview.incomingCommits.length > 0 && (
              <div>
                <div className="mb-1 font-semibold">Incoming commits:</div>
                <ul className="max-h-40 overflow-auto rounded border bg-muted/30 p-2">
                  {preview.incomingCommits.map((c) => (
                    <li key={c.hash} className="truncate font-mono text-[11px]">
                      <span className="text-muted-foreground">
                        {c.shortHash}
                      </span>{" "}
                      {c.subject}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Close
          </Button>
          <Button onClick={runPreview} disabled={loading || !from || !into}>
            {loading ? "Computing…" : "Run preview"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
