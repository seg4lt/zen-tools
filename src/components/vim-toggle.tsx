/**
 * Round icon button that flips the global Vim-mode preference. Persists
 * to `preferences.json` (the `vimMode` field) via the `useVimMode` hook,
 * so the choice survives across launches and is shared by every editor
 * in the app (HTTP runner + Database Explorer + Markdown).
 */

import { Button } from "@zen-tools/ui";
import { useVimMode } from "@/hooks/use-vim-mode";

export function VimToggle() {
  const { vimMode, setVimMode, isLoaded } = useVimMode();
  if (!isLoaded) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => void setVimMode(!vimMode)}
      aria-label={`${vimMode ? "Disable" : "Enable"} Vim keybindings`}
      aria-pressed={vimMode}
      title={`Vim mode: ${vimMode ? "on" : "off"}`}
      className="size-7"
    >
      <span
        className={
          "font-mono text-[11px] font-semibold leading-none tracking-tight transition " +
          (vimMode ? "text-foreground" : "text-muted-foreground/60")
        }
      >
        Vim
      </span>
    </Button>
  );
}
