import { useRouterState } from "@tanstack/react-router";
import { TOOLS } from "@/config/tools";
import { ToolPill } from "./tool-pill";
import { WorkingDirPicker } from "./working-dir-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";

/**
 * Top bar with traffic-light gap on the left, segmented tool pills, and
 * action group on the right (working dir + theme toggle). Drag region
 * covers everything but interactive children.
 */
export function TitleBar() {
  const { location } = useRouterState();
  const activeToolId = TOOLS.find((t) =>
    location.pathname.startsWith(t.route),
  )?.id;

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-10 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur-sm"
    >
      {/* macOS traffic-light gap (we use overlay style; OS draws here) */}
      <div className="w-16 shrink-0" data-tauri-drag-region />

      {/* Segmented tool pills */}
      <div className="flex h-7 items-center gap-1 rounded-md bg-muted/50 p-0.5">
        {TOOLS.map((tool) => (
          <ToolPill
            key={tool.id}
            tool={tool}
            active={tool.id === activeToolId}
          />
        ))}
      </div>

      {/* Right group */}
      <div
        className="ml-auto flex items-center gap-1"
        // Stop the drag region from swallowing pointer events on this group.
        data-tauri-drag-region={false}
      >
        <WorkingDirPicker />
        <Separator orientation="vertical" className="mx-1 h-4" />
        <ThemeToggle />
      </div>
    </header>
  );
}
