/**
 * Process Monitor — top-level shell.
 *
 * Routes between the three views (picker, dashboard, settings) just
 * like the original Leptos app.
 *
 * The store provider (`ProcessMonitorStoreProvider`) lives in
 * `<AppProviders>` at the router root so per-tool state (selected
 * targets, view, settings) survives navigation between tools.
 *
 * The macOS menu-bar tray icon is managed entirely backend-side
 * (`src-tauri/src/tray.rs`). The frontend only needs to call
 * `pm_set_targets` / `pm_clear_targets` — the tray reflects state
 * automatically.
 */

import { Pencil, Settings as SettingsIcon, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pmTauri } from "./lib/tauri";
import { Dashboard } from "./components/Dashboard";
import { Picker } from "./components/Picker";
import { Settings } from "./components/Settings";
import { useProcessMonitorStore } from "./store/process-monitor-store";

export function ProcessMonitorShell() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SubNav />
      <div className="flex min-h-0 flex-1">
        <ViewSwitcher />
      </div>
    </div>
  );
}

function SubNav() {
  const { state, dispatch } = useProcessMonitorStore();

  const title = (() => {
    switch (state.view) {
      case "dashboard": {
        const n = state.targets.length;
        return n === 1 ? "1 process" : `${n} processes`;
      }
      case "picker":
        return "Select processes";
      case "settings":
        return "Settings";
    }
  })();

  const onStop = async () => {
    try {
      await pmTauri.clearTargets();
      dispatch({ type: "clearTargets" });
    } catch (err) {
      console.error("[shell] clear_targets failed", err);
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
      <span className="text-sm font-medium">{title}</span>
      <div className="ml-auto flex items-center gap-1">
        {state.view === "dashboard" && (
          <>
            <Button
              size="xs"
              variant="ghost"
              title="Edit selection"
              onClick={() => dispatch({ type: "view", view: "picker" })}
            >
              <Pencil className="size-3" />
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              title="Stop monitoring all"
              onClick={onStop}
            >
              <StopCircle className="size-3" />
              Stop
            </Button>
          </>
        )}
        {state.view === "settings" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              dispatch({
                type: "view",
                view: state.targets.length > 0 ? "dashboard" : "picker",
              })
            }
          >
            Done
          </Button>
        ) : state.view === "picker" && state.targets.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => dispatch({ type: "view", view: "dashboard" })}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          title="Settings"
          onClick={() => dispatch({ type: "view", view: "settings" })}
        >
          <SettingsIcon className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function ViewSwitcher() {
  const { state } = useProcessMonitorStore();
  switch (state.view) {
    case "picker":
      return <Picker />;
    case "dashboard":
      return <Dashboard />;
    case "settings":
      return <Settings />;
  }
}
