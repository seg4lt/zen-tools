/**
 * Dictation settings section.
 *
 * Two-layer UX:
 *
 *   1. **Master enable switch** — toggles the tool on / off via the
 *      shared `set_tool_disabled` Tauri command (same wiring PRMaster
 *      uses, see `src/hooks/use-tool-order.tsx`). When off the
 *      backend `dictation::lifecycle::stop` runs: the CGEventTap is
 *      uninstalled, the mic tray is hidden, and any in-flight
 *      recording is abandoned. Right-⌘ goes back to behaving like a
 *      regular modifier.
 *
 *   2. **Model picker + download UX** — only meaningful when the
 *      tool is enabled. Hidden behind the disabled state so the user
 *      isn't tempted to fiddle with options that have no effect.
 *
 * Lives at /settings; mounted unconditionally by `SettingsView` (the
 * old `isAppEnabled` stub is gone now that we have the real
 * `disabled_tools` mechanism).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DICTATION_PERMISSIONS_KEY,
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
  Switch,
} from "@zen-tools/ui";
import { useToolOrder } from "@/hooks/use-tool-order";

const DICTATION_TOOL_ID = "dictation";

export function DictationSection() {
  const qc = useQueryClient();
  const { disabledIds, setDisabled, isLoaded } = useToolOrder();
  const enabled = useMemo(
    () => !disabledIds.has(DICTATION_TOOL_ID),
    [disabledIds],
  );

  // Don't query the backend snapshot until the user has the tool
  // enabled — otherwise we'd kick off a query for state that's
  // intentionally torn down.
  const { data: state } = useQuery({
    queryKey: DICTATION_STATE_KEY,
    queryFn: dictationIpc.getState,
    enabled: isLoaded && enabled,
  });

  const [progress, setProgress] = useState<Record<string, DownloadProgressDto>>(
    {},
  );

  // Subscribe to download progress only while enabled. Re-attaches on
  // every enable→disable→enable cycle so we don't leak the listener.
  useEffect(() => {
    if (!enabled) {
      setProgress({});
      return;
    }
    let unlisten: (() => void) | undefined;
    listenDownloadProgress((p) => {
      setProgress((prev) => {
        const next = { ...prev, [p.model_id]: p };
        if (p.total != null && p.downloaded >= p.total) {
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
  }, [qc, enabled]);

  const selectModel = useMutation({
    mutationFn: (id: string) => dictationIpc.selectModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  const downloadModel = useMutation({
    mutationFn: (id: string) => dictationIpc.downloadModel(id),
  });

  const toggleEnabled = useMutation({
    mutationFn: async (next: boolean) => {
      // `setDisabled` is the user-facing word; the IPC argument is
      // inverted — true means "disable this tool".
      await setDisabled(DICTATION_TOOL_ID, !next);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  // ── macOS Accessibility permission UX ──────────────────────────────
  // Refetched on every focus/visibility change so a grant the user
  // just toggled in System Settings shows up here without a manual
  // refresh. Cheap (one `AXIsProcessTrusted()` syscall on the backend).
  const { data: perms, refetch: refetchPerms } = useQuery({
    queryKey: DICTATION_PERMISSIONS_KEY,
    queryFn: dictationIpc.getPermissions,
    enabled: isLoaded && enabled,
    refetchOnWindowFocus: true,
  });

  const resetAccessibility = useMutation({
    mutationFn: dictationIpc.resetAccessibility,
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_PERMISSIONS_KEY }),
  });
  const resetMicrophone = useMutation({
    mutationFn: dictationIpc.resetMicrophone,
  });
  const openAxPane = useMutation({
    mutationFn: () => dictationIpc.openPrivacyPane("Privacy_Accessibility"),
  });
  const openMicPane = useMutation({
    mutationFn: () => dictationIpc.openPrivacyPane("Privacy_Microphone"),
  });

  const selected = state?.models.find((m) => m.id === state.selected_model);
  const showDownloadButton =
    enabled && selected && !selected.is_downloaded && !progress[selected.id];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Enable dictation</span>
          <span className="text-[10px] text-muted-foreground">
            Off — right ⌘ behaves normally; no microphone, no model loaded,
            no menu-bar indicator.
          </span>
        </div>
        <Switch
          checked={enabled}
          disabled={!isLoaded || toggleEnabled.isPending}
          onCheckedChange={(v) => toggleEnabled.mutate(v)}
          aria-label="Enable dictation"
        />
      </div>

      {enabled && perms?.accessibility_granted === false && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-medium">Accessibility permission required</div>
          <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            The right-⌘ hotkey can't fire without this. macOS won't
            re-prompt once an entry exists in TCC, so use{" "}
            <em>Reset & re-prompt</em> below if the toggle in System
            Settings is dead (typical after reinstalling an unsigned
            build — the cdhash changes and the existing entry no
            longer matches).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => resetAccessibility.mutate()}
              disabled={resetAccessibility.isPending}
              className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              {resetAccessibility.isPending ? "Resetting…" : "Reset & re-prompt"}
            </button>
            <button
              type="button"
              onClick={() => openAxPane.mutate()}
              className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent"
            >
              Open System Settings
            </button>
            <button
              type="button"
              onClick={() => refetchPerms()}
              className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent"
            >
              Re-check
            </button>
          </div>
          {resetAccessibility.error instanceof Error && (
            <p className="mt-1 text-[10px] text-red-500">
              {resetAccessibility.error.message}
            </p>
          )}
        </div>
      )}

      {enabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-[11px]">
          <span className="font-medium">Microphone</span>
          <span className="text-muted-foreground">
            asks on first use; macOS re-prompts on each install only when
            the app is unsigned (cdhash changes between builds).
          </span>
          <button
            type="button"
            onClick={() => resetMicrophone.mutate()}
            disabled={resetMicrophone.isPending}
            className="rounded-md border border-border/60 bg-card px-2 py-0.5 hover:bg-accent disabled:opacity-50"
          >
            {resetMicrophone.isPending ? "Resetting…" : "Reset"}
          </button>
          <button
            type="button"
            onClick={() => openMicPane.mutate()}
            className="rounded-md border border-border/60 bg-card px-2 py-0.5 hover:bg-accent"
          >
            Open System Settings
          </button>
          {resetMicrophone.error instanceof Error && (
            <span className="text-[10px] text-red-500">
              {resetMicrophone.error.message}
            </span>
          )}
        </div>
      )}

      {enabled && (
        <>
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
            // before doing percentage math.
            const downloaded = Number(p.downloaded);
            const total = p.total != null ? Number(p.total) : null;
            const pct =
              total != null
                ? Math.min(
                    100,
                    Math.round((downloaded / Math.max(1, total)) * 100),
                  )
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
            Tap the right ⌘ key quickly, then hold it for ~½ second to start
            recording. Recording stays on after you release. Repeat the
            same gesture (tap, then hold) to stop, transcribe, and paste.
            First use of any model loads the weights from disk into memory.
          </p>

          <p className="text-[10px] text-muted-foreground">
            Models are downloaded from{" "}
            <code className="font-mono text-[10px]">
              huggingface.co/ggerganov/whisper.cpp
            </code>{" "}
            (the canonical ggml weights for Whisper). Files are written to
            the Dictation models directory listed in <em>Paths</em> below;
            click <em>Open in Finder</em> there to inspect them.
          </p>
        </>
      )}
    </div>
  );
}
