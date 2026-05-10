/**
 * Read-only "Paths" section for Settings.
 *
 * Surfaces where the app is keeping its data — the global app data
 * dir, the logs dir, the dictation models dir, and the AI Review
 * reports dir. Each row has an "Open in Finder" button that reveals
 * the folder in the system file manager. The actual paths are
 * resolved on the Rust side via `app.path().app_data_dir()` so they
 * always match what the runtime is writing to.
 */
import { useQuery } from "@tanstack/react-query";
import { DICTATION_PATHS_KEY, dictationIpc } from "@zen-tools/ipc";
import { prmasterTauri } from "@/tools/prmaster/lib/tauri";

export function PathsSection() {
  const { data: paths } = useQuery({
    queryKey: DICTATION_PATHS_KEY,
    queryFn: dictationIpc.getPaths,
  });

  // The AI Review reports dir is always `<app_data>/prmaster/ai-review/reports/`
  // — we render the path string by deriving it from the same
  // `app_data_dir` the dictation paths query already resolved, so we
  // don't need a second IPC roundtrip just to show it.
  const aiReviewReportsPath = paths?.app_data_dir
    ? joinPath(paths.app_data_dir, "prmaster", "ai-review", "reports")
    : undefined;

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
        label="AI Review reports"
        path={aiReviewReportsPath}
        onOpen={prmasterTauri.aiReviewOpenReportsDir}
      />
      <PathRow
        label="Dictation models"
        path={paths?.models_dir}
        onOpen={dictationIpc.openModelsDir}
      />
    </div>
  );
}

/** OS-aware path joiner. The frontend only needs this for display
 *  (the Open command resolves the real path on the Rust side via
 *  `app_data_dir().join(...)`), so a simple separator pick is fine —
 *  we use `\` only when the resolved app-data path looks Windowsy
 *  and `/` everywhere else. */
function joinPath(...parts: string[]): string {
  if (parts.length === 0) return "";
  const head = parts[0];
  const sep = head.includes("\\") && !head.includes("/") ? "\\" : "/";
  return parts
    .map((p, i) =>
      i === 0
        ? p.replace(/[/\\]+$/, "")
        : p.replace(/^[/\\]+/, "").replace(/[/\\]+$/, ""),
    )
    .filter((p) => p.length > 0)
    .join(sep);
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
