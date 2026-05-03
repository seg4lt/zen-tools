/**
 * Dictation settings section.
 *
 * Renders the model dropdown (fastest → slowest with descriptions and
 * download status), wires download-progress events into a per-model
 * progress bar, and exposes a "Download now" button when the selected
 * model isn't yet on disk.
 *
 * Gated externally by the global "app enabled" flag — `SettingsView`
 * only mounts this component when that flag is on. The flag itself is
 * being added by the parallel agent's branch; for now the parent stubs
 * `isAppEnabled` to `false` so this section stays hidden until the
 * merge.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DICTATION_STATE_KEY,
  dictationIpc,
  listenDownloadProgress,
  type DownloadProgressDto,
} from "@zen-tools/ipc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zen-tools/ui";

export function DictationSection() {
  const qc = useQueryClient();
  const { data: state } = useQuery({
    queryKey: DICTATION_STATE_KEY,
    queryFn: dictationIpc.getState,
  });

  // Per-model download progress. Cleared once the matching `total ===
  // downloaded` tick arrives (or 30s after the last update — see the
  // cleanup effect below for the keep-alive heuristic).
  const [progress, setProgress] = useState<Record<string, DownloadProgressDto>>(
    {},
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenDownloadProgress((p) => {
      setProgress((prev) => {
        const next = { ...prev, [p.model_id]: p };
        // Auto-clear when complete.
        if (p.total != null && p.downloaded >= p.total) {
          // Defer one tick so the bar visually completes before
          // disappearing.
          setTimeout(() => {
            setProgress((cur) => {
              const c = { ...cur };
              delete c[p.model_id];
              return c;
            });
            void qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY });
          }, 600);
        }
        return next;
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [qc]);

  const selectModel = useMutation({
    mutationFn: (id: string) => dictationIpc.selectModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  const downloadModel = useMutation({
    mutationFn: (id: string) => dictationIpc.downloadModel(id),
  });

  const selected = state?.models.find((m) => m.id === state.selected_model);
  const showDownloadButton = selected && !selected.is_downloaded && !progress[selected.id];

  return (
    <div className="flex flex-col gap-3">
      <Select
        value={state?.selected_model}
        onValueChange={(id) => selectModel.mutate(id)}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select model…" />
        </SelectTrigger>
        <SelectContent>
          {state?.models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {m.size_label}
                  </span>
                  {m.is_default && (
                    <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
                      recommended
                    </span>
                  )}
                  {!m.is_downloaded && (
                    <span className="text-[10px] text-amber-500">
                      not downloaded
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {m.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {Object.entries(progress).map(([id, p]) => {
        // ts-rs maps Rust's `u64` to `bigint`; coerce to `number`
        // before doing percentage math. Model sizes top out at a
        // few GB (well under `Number.MAX_SAFE_INTEGER` = 2^53),
        // so no precision is lost.
        const downloaded = Number(p.downloaded);
        const total = p.total != null ? Number(p.total) : null;
        const pct =
          total != null
            ? Math.min(100, Math.round((downloaded / Math.max(1, total)) * 100))
            : null;
        const model = state?.models.find((m) => m.id === id);
        return (
          <div key={id} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Downloading {model?.label ?? id}…</span>
              <span>{pct != null ? `${pct}%` : "…"}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: pct != null ? `${pct}%` : "10%" }}
              />
            </div>
          </div>
        );
      })}

      {showDownloadButton && (
        <button
          type="button"
          onClick={() => downloadModel.mutate(selected.id)}
          disabled={downloadModel.isPending}
          className="self-start rounded-md border border-border/60 bg-card px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {downloadModel.isPending ? "Starting…" : "Download now"}
        </button>
      )}

      <p className="text-[10px] text-muted-foreground">
        Long-press the right ⌘ key to record. Release to transcribe and paste.
        First use of any model loads the weights from disk into memory.
      </p>
    </div>
  );
}
