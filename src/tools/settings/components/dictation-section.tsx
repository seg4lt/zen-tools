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
  listenPermissionsChanged,
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

  const setProvider = useMutation({
    mutationFn: (p: "apple-speech" | "whisper") => dictationIpc.setProvider(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  const installAppleLocale = useMutation({
    mutationFn: (locale?: string) => dictationIpc.installAppleLocale(locale),
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  const setScreenVocab = useMutation({
    mutationFn: (enabled: boolean) => dictationIpc.setScreenVocab(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  const testScreenVocab = useMutation({
    mutationFn: () => dictationIpc.testScreenVocab(),
  });

  const resetScreenRecording = useMutation({
    mutationFn: () => dictationIpc.resetScreenRecording(),
    // After reset we automatically re-run the test — the snapshot
    // call inside the reset command triggers the system prompt; once
    // the user clicks Allow, this re-test surfaces the fresh result
    // without them having to find the button again.
    onSuccess: () => testScreenVocab.mutate(),
  });
  const openScreenRecordingPane = useMutation({
    mutationFn: () => dictationIpc.openPrivacyPane("Privacy_ScreenCapture"),
  });

  const toggleEnabled = useMutation({
    mutationFn: async (next: boolean) => {
      // `setDisabled` is the user-facing word; the IPC argument is
      // inverted — true means "disable this tool".
      await setDisabled(DICTATION_TOOL_ID, !next);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_STATE_KEY }),
  });

  // ── macOS Accessibility + Microphone permission UX ─────────────────
  // The backend's auto-recovery flow handles the common stale-cdhash
  // case automatically (see `src-tauri/src/dictation/lifecycle.rs`).
  // The UI's job is reduced to:
  //
  //   * showing a banner only when the auto-fix can't / shouldn't
  //     proceed (deliberate denial, restricted-by-MDM, or auto-fix
  //     attempted but the user dismissed the prompt), and
  //   * exposing the manual reset / deep-link buttons as a fallback
  //     for the cases the heuristic doesn't catch.
  //
  // The query refetches on window focus AND on
  // `dictation:permissions-changed` events the backend emits the
  // moment a grant lands — so the banner clears the instant the user
  // clicks Allow on the system prompt, without waiting for them to
  // alt-tab back into the app.
  const { data: perms, refetch: refetchPerms } = useQuery({
    queryKey: DICTATION_PERMISSIONS_KEY,
    queryFn: dictationIpc.getPermissions,
    enabled: isLoaded && enabled,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    void listenPermissionsChanged(() => {
      void qc.invalidateQueries({ queryKey: DICTATION_PERMISSIONS_KEY });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [enabled, qc]);

  const resetAccessibility = useMutation({
    mutationFn: dictationIpc.resetAccessibility,
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_PERMISSIONS_KEY }),
  });
  const resetMicrophone = useMutation({
    mutationFn: dictationIpc.resetMicrophone,
    onSuccess: () => qc.invalidateQueries({ queryKey: DICTATION_PERMISSIONS_KEY }),
  });
  const openAxPane = useMutation({
    mutationFn: () => dictationIpc.openPrivacyPane("Privacy_Accessibility"),
  });
  const openMicPane = useMutation({
    mutationFn: () => dictationIpc.openPrivacyPane("Privacy_Microphone"),
  });

  // Banner-suppression rule: don't show the manual-fix UI while the
  // backend is mid-auto-fix. We approximate "mid-auto-fix" as "denied
  // AND the install-id heuristic does NOT classify this as a
  // deliberate denial" — in that window the system prompt is on
  // screen (or about to be) and the user just needs to click Allow.
  const axNeedsManual =
    perms?.accessibility_granted === false && perms.accessibility_deliberate_denial;
  const micNeedsManual =
    perms?.microphone_status === "denied" && perms.microphone_deliberate_denial;
  const micRestricted = perms?.microphone_status === "restricted";

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

      {enabled && axNeedsManual && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-medium">Accessibility permission denied</div>
          <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            We previously had Accessibility on this build but the
            toggle is now off. If you turned it off on purpose, leave
            it; the right-⌘ hotkey will stay disabled until you flip
            it back. If you're stuck (toggling the System Settings
            switch does nothing), use <em>Reset & re-prompt</em>.
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

      {enabled && micRestricted && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          <div className="font-medium">Microphone access is restricted</div>
          <p className="mt-1 text-[11px] text-red-700/80 dark:text-red-300/80">
            Your device's configuration profile or parental controls
            block microphone access. Dictation can't be enabled until
            an administrator lifts the restriction.
          </p>
        </div>
      )}

      {enabled && micNeedsManual && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-medium">Microphone permission denied</div>
          <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            You denied microphone access on this build. If that was
            intentional, leave it; dictation stays disabled. To grant,
            either flip the toggle in System Settings or use{" "}
            <em>Reset & re-prompt</em>.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => resetMicrophone.mutate()}
              disabled={resetMicrophone.isPending}
              className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              {resetMicrophone.isPending ? "Resetting…" : "Reset & re-prompt"}
            </button>
            <button
              type="button"
              onClick={() => openMicPane.mutate()}
              className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent"
            >
              Open System Settings
            </button>
          </div>
          {resetMicrophone.error instanceof Error && (
            <p className="mt-1 text-[10px] text-red-500">
              {resetMicrophone.error.message}
            </p>
          )}
        </div>
      )}

      {enabled && state && (
        <>
          {/* ── Provider selector ────────────────────────────────────
              Hidden entirely on macOS < 26 / older Xcode builds where
              the Apple Speech bridge isn't compiled — there's only one
              option (Whisper) so we save the user the noise.            */}
          {state.apple_speech.supported && (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2">
              <div className="text-xs font-medium">Engine</div>
              <div className="flex flex-col gap-1.5">
                <ProviderRadio
                  id="apple-speech"
                  label="Apple Speech"
                  description="On-device, faster, no per-app download. macOS 26+."
                  checked={state.provider === "apple-speech"}
                  onSelect={() => setProvider.mutate("apple-speech")}
                  disabled={setProvider.isPending}
                  badge="recommended"
                />
                <ProviderRadio
                  id="whisper"
                  label="Whisper (whisper.cpp)"
                  description="Open-source. Pick a model size below; weights are downloaded once."
                  checked={state.provider === "whisper"}
                  onSelect={() => setProvider.mutate("whisper")}
                  disabled={setProvider.isPending}
                />
              </div>
            </div>
          )}

          {/* ── Screen vocabulary toggle ────────────────────────────────
              Available on macOS only (where ScreenCaptureKit + Vision
              ship). Off by default — flipping it on triggers the
              Screen Recording TCC prompt the next time dictation
              records. Applies to both Apple Speech and Whisper: the
              backend formats the OCR'd vocabulary appropriately for
              each provider's contextual-hint API.                       */}
          {state.screen_vocab.supported && (
            <div className="flex items-start justify-between rounded-md border border-border/60 bg-card/40 px-3 py-2">
              <div className="flex flex-1 flex-col gap-0.5 pr-3">
                <span className="text-sm font-medium">Improve accuracy from screen</span>
                <span className="text-[10px] text-muted-foreground">
                  Read words visible on your screen (proper nouns, code
                  identifiers, jargon) right before each transcription
                  to bias the recogniser. Nothing is recorded or sent
                  off-device — only the extracted vocabulary list
                  reaches the speech model, and only for that one
                  utterance.
                </span>
                <span className="text-[10px] text-muted-foreground">
                  First-time use will prompt for Screen Recording
                  permission in System Settings.
                </span>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Switch
                  checked={state.screen_vocab.enabled}
                  disabled={setScreenVocab.isPending}
                  onCheckedChange={(v) => setScreenVocab.mutate(v)}
                  aria-label="Improve accuracy from screen"
                />
                {state.screen_vocab.enabled && (
                  <button
                    type="button"
                    onClick={() => testScreenVocab.mutate()}
                    disabled={testScreenVocab.isPending}
                    className="rounded-md border border-border/60 bg-card px-2 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
                  >
                    {testScreenVocab.isPending ? "Reading…" : "Show what I see"}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Test-snapshot result panel — only shown after the user
              clicks "Show what I see". Renders the OCR output so the
              user can verify the pipeline end-to-end without having
              to dictate something first.

              Three render branches:
                1. TCC denial → self-heal banner (Reset & re-prompt /
                   Open Settings / Re-check), mirrors the existing
                   accessibility / microphone banner pattern.
                2. Empty terms, no error → amber "heuristic kept
                   nothing" hint.
                3. Non-empty terms → comma-separated preview list.       */}
          {state.screen_vocab.supported && testScreenVocab.data && (() => {
            const data = testScreenVocab.data;
            // Heuristic detection of the TCC denial: ScreenCaptureKit
            // surfaces its decline message as `screen vocab snapshot
            // failed: The user declined TCCs for application, window,
            // display capture`. We look for "TCC" or "declined" so
            // the banner triggers regardless of minor phrasing
            // changes across macOS versions.
            const isTccError =
              !!data.error &&
              (data.error.includes("TCC") ||
                data.error.toLowerCase().includes("declined") ||
                data.error.toLowerCase().includes("not authorized"));

            if (isTccError) {
              return (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <div className="font-medium">
                    Screen Recording permission denied
                  </div>
                  <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                    macOS blocked the OCR snapshot because Zen Tools
                    isn't allowed to record the screen. If you turned
                    this off on purpose, leave it; the screen-vocab
                    feature stays disabled. If the toggle in System
                    Settings is unresponsive (typical after an
                    unsigned-build reinstall), use{" "}
                    <em>Reset &amp; re-prompt</em>.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => resetScreenRecording.mutate()}
                      disabled={resetScreenRecording.isPending}
                      className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                    >
                      {resetScreenRecording.isPending
                        ? "Resetting…"
                        : "Reset & re-prompt"}
                    </button>
                    <button
                      type="button"
                      onClick={() => openScreenRecordingPane.mutate()}
                      className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent"
                    >
                      Open System Settings
                    </button>
                    <button
                      type="button"
                      onClick={() => testScreenVocab.mutate()}
                      disabled={testScreenVocab.isPending}
                      className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                    >
                      {testScreenVocab.isPending ? "Re-checking…" : "Re-check"}
                    </button>
                  </div>
                  {resetScreenRecording.error instanceof Error && (
                    <p className="mt-1 text-[10px] text-red-500">
                      {resetScreenRecording.error.message}
                    </p>
                  )}
                  <p className="mt-2 text-[10px] text-amber-700/60 dark:text-amber-300/60">
                    Raw error: {data.error}
                  </p>
                </div>
              );
            }

            return (
              <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Screen vocab preview</span>
                  <span className="text-[10px] text-muted-foreground">
                    {data.terms.length} terms
                  </span>
                </div>
                {data.error && (
                  <p className="mt-1 text-[11px] text-red-500">
                    Error: {data.error}
                  </p>
                )}
                {data.terms.length === 0 && !data.error && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    OCR ran but the heuristic kept nothing. Either the
                    screen has no jargon visible right now, or only
                    common UI chrome / English words were on screen.
                  </p>
                )}
                {data.terms.length > 0 && (
                  <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {data.terms.slice(0, 60).join(", ")}
                    {data.terms.length > 60 && " …"}
                  </p>
                )}
              </div>
            );
          })()}

          {/* ── Apple Speech: locale install banner ─────────────────── */}
          {state.provider === "apple-speech" && state.apple_speech.supported && (
            <AppleSpeechPanel
              locale={state.apple_speech.locale}
              installed={state.apple_speech.installed}
              installPending={installAppleLocale.isPending}
              onInstall={() => installAppleLocale.mutate(undefined)}
              installError={
                installAppleLocale.error instanceof Error
                  ? installAppleLocale.error.message
                  : null
              }
              progress={progress[`apple-speech:${state.apple_speech.locale}`]}
            />
          )}

          {/* ── Whisper: model picker + download flow ───────────────── */}
          {state.provider === "whisper" && (
            <>
              <Select
                value={state.selected_model}
                onValueChange={(id) => selectModel.mutate(id)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select model…" />
                </SelectTrigger>
                <SelectContent>
                  {state.models.map((m) => (
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

              {Object.entries(progress)
                // Filter out apple-speech pseudo-progress; that bar
                // lives in `AppleSpeechPanel`.
                .filter(([id]) => !id.startsWith("apple-speech:"))
                .map(([id, p]) => {
                  // ts-rs maps Rust's `u64` to `bigint`; coerce to
                  // `number` before doing percentage math.
                  const downloaded = Number(p.downloaded);
                  const total = p.total != null ? Number(p.total) : null;
                  const pct =
                    total != null
                      ? Math.min(
                          100,
                          Math.round((downloaded / Math.max(1, total)) * 100),
                        )
                      : null;
                  const model = state.models.find((m) => m.id === id);
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

          <p className="text-[10px] text-muted-foreground">
            Tap the right ⌘ key quickly, then hold it for ~½ second to start
            recording. Recording stays on after you release. Repeat the
            same gesture (tap, then hold) to stop, transcribe, and paste.
            First use of a backend loads the model into memory.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Plain radio row — accessible focus ring, full-row click target,
 * matches the visual weight of the existing "Enable dictation" card.
 */
function ProviderRadio(props: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  badge?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
        props.checked
          ? "border-primary/60 bg-primary/5"
          : "border-border/40 hover:bg-accent/40"
      } ${props.disabled ? "opacity-60" : ""}`}
    >
      <input
        type="radio"
        name="dictation-provider"
        value={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => props.onSelect()}
        className="mt-0.5"
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {props.label}
          {props.badge && (
            <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
              {props.badge}
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground">
          {props.description}
        </span>
      </div>
    </label>
  );
}

/**
 * Apple Speech locale install panel. Three states:
 *
 *   * installed → soft confirmation, no action needed
 *   * not installed, no install in flight → "Install language model" button
 *   * install in flight → indeterminate progress bar (the Swift
 *     bridge doesn't tee byte-level progress yet, so the bar is a
 *     simple "in progress" indicator until completion)
 */
function AppleSpeechPanel(props: {
  locale: string;
  installed: boolean;
  installPending: boolean;
  onInstall: () => void;
  installError: string | null;
  progress?: DownloadProgressDto;
}) {
  if (props.installed) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
        <span className="font-medium text-emerald-700 dark:text-emerald-300">
          Apple Speech ready
        </span>
        <span className="ml-1 text-muted-foreground">
          ({props.locale} model installed)
        </span>
      </div>
    );
  }

  const inProgress = props.installPending || props.progress != null;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
      <div className="font-medium text-amber-700 dark:text-amber-300">
        Apple Speech: language model not installed
      </div>
      <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
        First-time setup downloads the on-device speech model
        (~50 MB) into the system-wide store. It's shared with every
        other app on this Mac, so you'll only ever do this once per
        device.
      </p>
      {inProgress ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Installing {props.locale} model…</span>
            <span>…</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {/* Indeterminate-ish bar: 30% width, gentle pulse via
                tailwind's animate-pulse. Replace with a real percentage
                once the Swift bridge tees AssetInventory progress. */}
            <div className="h-full w-1/3 animate-pulse bg-primary" />
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => props.onInstall()}
            disabled={props.installPending}
            className="rounded-md border border-border/60 bg-card px-2.5 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
          >
            Install language model
          </button>
          <span className="text-[10px] text-muted-foreground">
            (~50 MB, one-time)
          </span>
        </div>
      )}
      {props.installError && (
        <p className="mt-1 text-[10px] text-red-500">{props.installError}</p>
      )}
    </div>
  );
}
