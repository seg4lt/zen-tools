/**
 * Read-only "Paths" section for Settings.
 *
 * Surfaces where the app is keeping its data — app data dir, logs
 * dir, and (for transparency) the dictation models dir. Each row has
 * an "Open in Finder" button that calls into the shell plugin via
 * the Tauri command layer. The actual paths are resolved on the Rust
 * side via `app.path().app_data_dir()` so they always match what the
 * runtime is writing to.
 */
import { useQuery } from "@tanstack/react-query";
import { DICTATION_PATHS_KEY, dictationIpc } from "@zen-tools/ipc";

export function PathsSection() {
  const { data: paths } = useQuery({
    queryKey: DICTATION_PATHS_KEY,
    queryFn: dictationIpc.getPaths,
  });

  return (
    <div className="flex flex-col gap-2 text-xs">
      <PathRow
        label="App data"
        path={paths?.app_data_dir}
        onOpen={dictationIpc.openAppDataDir}
      />
      <PathRow
        label="Logs"
        path={paths?.logs_dir}
        onOpen={dictationIpc.openLogsDir}
      />
      <PathRow
        label="Dictation models"
        path={paths?.models_dir}
        onOpen={dictationIpc.openAppDataDir}
      />
    </div>
  );
}

function PathRow({
  label,
  path,
  onOpen,
}: {
  label: string;
  path?: string;
  onOpen: () => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">{label}</span>
        <span
          className="font-mono text-[10px] text-muted-foreground"
          title={path}
        >
          {path ?? "—"}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void onOpen()}
        className="shrink-0 rounded-md border border-border/60 bg-card px-2 py-1 hover:bg-accent"
      >
        Open in Finder
      </button>
    </div>
  );
}
