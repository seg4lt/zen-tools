/**
 * Zoom widget for the settings page: minus, current level, plus, and a
 * Reset button. All four wired to `useAppZoom`. The same operations
 * are reachable globally via ⌘= / ⌘− / ⌘0.
 */
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { useAppZoom, APP_ZOOM_LIMITS } from "@/hooks/use-app-zoom";
import { isMac } from "@zen-tools/keyboard";

export function ZoomControl() {
  const { zoom, zoomIn, zoomOut, reset } = useAppZoom();
  const pct = Math.round(zoom * 100);
  const atMin = zoom <= APP_ZOOM_LIMITS.min + 1e-6;
  const atMax = zoom >= APP_ZOOM_LIMITS.max - 1e-6;
  const atDefault = Math.abs(zoom - APP_ZOOM_LIMITS.default) < 1e-6;
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div className="flex items-center gap-2">
      <div className="inline-flex items-center rounded-md border border-border/60 bg-background">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 rounded-r-none p-0"
          onClick={() => void zoomOut()}
          disabled={atMin}
          title={`Zoom out (${mod}−)`}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="min-w-[3.5rem] border-x border-border/60 px-2 py-1 text-center font-mono text-xs tabular-nums">
          {pct}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 rounded-l-none p-0"
          onClick={() => void zoomIn()}
          disabled={atMax}
          title={`Zoom in (${mod}=)`}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => void reset()}
        disabled={atDefault}
        title={`Reset (${mod}0)`}
      >
        <RotateCcw className="size-3" />
        Reset
      </Button>
      <span className="ml-auto text-[11px] text-muted-foreground/70">
        {mod}= · {mod}− · {mod}0
      </span>
    </div>
  );
}
