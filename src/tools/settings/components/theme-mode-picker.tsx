/**
 * Tri-state theme picker for the settings page: Light / Dark / System.
 *
 * "System" means follow `prefers-color-scheme` live — when the OS
 * theme changes the app re-paints without the user touching anything.
 * `useTheme()` resolves system → light/dark internally, so the rest
 * of the codebase keeps reading a concrete `theme: "light" | "dark"`.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";

interface Option {
  id: ThemeMode;
  label: string;
  icon: LucideIcon;
}

const OPTIONS: readonly Option[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

export function ThemeModePicker() {
  const { mode, setMode, theme } = useTheme();
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        role="radiogroup"
        aria-label="Theme mode"
        className="inline-flex items-stretch rounded-md border border-border/60 bg-background p-0.5"
      >
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = mode === opt.id;
          return (
            <Button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              variant="ghost"
              size="sm"
              onClick={() => setMode(opt.id)}
              className={cn(
                "h-7 gap-1 rounded-[5px] px-2 text-[11px]",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              title={opt.label}
            >
              <Icon className="size-3" />
              {opt.label}
            </Button>
          );
        })}
      </div>
      {mode === "system" && (
        <span className="text-[10px] text-muted-foreground/70">
          Following OS · currently {theme}
        </span>
      )}
    </div>
  );
}
