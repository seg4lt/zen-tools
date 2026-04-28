import { Folder } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

const STORAGE_KEY = "zen-tools.working-dir";

/**
 * Compact button in the top bar showing the active working directory and
 * letting the user open a folder picker. Persists the chosen path to
 * `localStorage` and restores it on mount so reopens skip the picker.
 *
 * Emits two custom events the rest of the app reacts to:
 *   - `zen:working-dir-changed`  (no detail)
 *   - `zen:env-auto-selected`    (detail: { env: string })
 */
export function WorkingDirPicker() {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  // Restore the last working directory on first render. If the saved path
  // doesn't exist any more (deleted, unmounted volume, …) the call errors
  // out and we fall back to the empty state without crashing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await invoke<string | null>("get_working_dir");
        if (current) {
          if (!cancelled) setPath(current);
          return;
        }
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (!stored) return;
        const env = await invoke<string | null>("set_working_dir", {
          path: stored,
        });
        if (cancelled) return;
        setPath(stored);
        await queryClient.invalidateQueries({ queryKey: ["working-dir"] });
        await queryClient.invalidateQueries({ queryKey: ["http-files"] });
        await queryClient.invalidateQueries({ queryKey: ["perf-files"] });
        await queryClient.invalidateQueries({ queryKey: ["environments"] });
        await queryClient.invalidateQueries({ queryKey: ["env-vars"] });
        announceWorkingDirChange();
        if (env) announceEnvAutoSelected(env);
      } catch {
        // Saved path no longer valid — drop it.
        window.localStorage.removeItem(STORAGE_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await invoke<string | null>("pick_directory");
      if (!picked) return;
      const env = await invoke<string | null>("set_working_dir", {
        path: picked,
      });
      window.localStorage.setItem(STORAGE_KEY, picked);
      setPath(picked);
      // Refetch every query keyed off the working dir.
      await queryClient.invalidateQueries({ queryKey: ["working-dir"] });
      await queryClient.invalidateQueries({ queryKey: ["http-files"] });
      await queryClient.invalidateQueries({ queryKey: ["perf-files"] });
      await queryClient.invalidateQueries({ queryKey: ["environments"] });
      await queryClient.invalidateQueries({ queryKey: ["env-vars"] });
      await queryClient.invalidateQueries({ queryKey: ["extracted-vars"] });
      announceWorkingDirChange();
      if (env) announceEnvAutoSelected(env);
    } catch (err) {
      console.error("pick directory failed", err);
    } finally {
      setBusy(false);
    }
  };

  const display = path
    ? path.length > 40
      ? `…${path.slice(-39)}`
      : path
    : "Pick directory";

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={busy}
      className="h-7 gap-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
      title={path ?? "Pick a working directory"}
    >
      <Folder className="size-3.5" />
      {display}
    </Button>
  );
}

function announceWorkingDirChange() {
  window.dispatchEvent(new CustomEvent("zen:working-dir-changed"));
}

function announceEnvAutoSelected(env: string) {
  window.dispatchEvent(
    new CustomEvent<{ env: string }>("zen:env-auto-selected", {
      detail: { env },
    }),
  );
}
