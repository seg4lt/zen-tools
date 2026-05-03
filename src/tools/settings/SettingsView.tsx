/**
 * Settings page. Sectioned vertical layout, scrollable.
 *
 * Sections:
 *  1. Theme — light / dark / system picker (uses ThemeModePicker).
 *  2. Vim mode — global Vim-keybinding flag (reuses VimToggle).
 *  3. Zoom    — ⌘= / ⌘− / ⌘0 + on-screen control.
 *  4. App order — drag-reorder of the tool pills.
 *  5. Dictation — Whisper enable switch + model picker. The Switch
 *     routes through `set_tool_disabled("dictation", ...)` so the
 *     backend lifecycle hook tears down the CGEventTap, mic tray, and
 *     any in-flight recording when the user disables the feature.
 *  6. Paths — app-data / logs / models directories with Open in Finder.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { dictationIpc } from "@zen-tools/ipc";
import { VimToggle } from "@/components/vim-toggle";
import { AppOrderList } from "./components/app-order-list";
import { DictationSection } from "./components/dictation-section";
import { PathsSection } from "./components/paths-section";
import { ThemeModePicker } from "./components/theme-mode-picker";
import { UpdateSection } from "./components/update-section";
import { ZoomControl } from "./components/zoom-control";

export function SettingsView() {
  // Dictation is macOS-only today (whisper.cpp ships Metal + Accelerate
  // backends in our vendored build; the Linux/Windows backends aren't
  // wired up). The backend command returns `cfg!(target_os = "macos")`
  // so the Settings UI hides the section entirely on other OSes
  // rather than showing a non-functional toggle.
  const { data: dictationSupported } = useQuery({
    queryKey: ["dictation", "supported"],
    queryFn: dictationIpc.isSupported,
    staleTime: Infinity,
  });

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
          title="Updates"
          description="Auto-checks every few hours. The yellow dot above appears whenever a new version is waiting; click Download and install to apply it now."
          fullWidthControl
          control={<UpdateSection />}
        />

        <Section
          title="Appearance"
          description="Light, dark, or follow the OS preference live."
          control={<ThemeModePicker />}
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

        {dictationSupported && (
          <Section
            title="Dictation"
            description="Local speech-to-text powered by Whisper. Tap the right ⌘ then hold it for ~½ second to start recording; repeat the gesture to stop, transcribe, and paste at the cursor."
            fullWidthControl
            control={<DictationSection />}
          />
        )}


        <Section
          title="Paths"
          description="Locations on disk used by Zen Tools. Logs rotate daily; dictation models cache here on first download."
          fullWidthControl
          control={<PathsSection />}
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
