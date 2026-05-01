/**
 * Settings page. Sectioned vertical layout, scrollable.
 *
 * Sections:
 *  1. Theme — light / dark toggle (reuses ThemeToggle).
 *  2. Vim mode — global Vim-keybinding flag (reuses VimToggle).
 *  3. Zoom    — ⌘= / ⌘− / ⌘0 + on-screen control.
 *  4. App order — drag-reorder of the tool pills.
 */
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { VimToggle } from "@/components/vim-toggle";
import { AppOrderList } from "./components/app-order-list";
import { ZoomControl } from "./components/zoom-control";

export function SettingsView() {
  return (
    <div className="flex h-full min-h-0 flex-1 justify-center overflow-auto bg-background">
      <div className="flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Preferences are persisted to the on-disk preferences file
            and shared across every tool.
          </p>
        </header>

        <Section
          title="Appearance"
          description="Switch between light and dark themes."
          control={<ThemeToggle />}
        />

        <Section
          title="Vim mode"
          description="Apply Vim keybindings to every CodeMirror editor (HTTP, SQL, Markdown)."
          control={<VimToggle />}
        />

        <Section
          title="Zoom"
          description="Scale the entire UI. Range 50%–200%, in 10% steps."
          fullWidthControl
          control={<ZoomControl />}
        />

        <Section
          title="App order"
          description="Drag the pills into the order you want to see them in the title bar."
          fullWidthControl
          control={<AppOrderList />}
        />
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  description: string;
  control: ReactNode;
  /** When true the control sits below the heading (full width) instead
   *  of beside it. Useful for multi-row controls (zoom, app order). */
  fullWidthControl?: boolean;
}

function Section({
  title,
  description,
  control,
  fullWidthControl,
}: SectionProps) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/40 p-4">
      <div
        className={
          fullWidthControl
            ? "flex flex-col gap-1"
            : "flex items-start justify-between gap-4"
        }
      >
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <div
          className={
            fullWidthControl ? "mt-2 flex flex-col gap-2" : "shrink-0"
          }
        >
          {control}
        </div>
      </div>
    </section>
  );
}
