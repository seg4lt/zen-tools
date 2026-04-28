import { Folder } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

/**
 * Compact button in the top bar showing the active working directory and
 * letting the user open a folder picker.
 */
export function WorkingDirPicker() {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<string>("get_working_dir")
      .then((p) => setPath(p))
      .catch(() => setPath(null));
  }, []);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await invoke<string | null>("pick_directory");
      if (picked) {
        await invoke<void>("set_working_dir", { path: picked });
        setPath(picked);
      }
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
