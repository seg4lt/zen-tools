import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { getWindowKind } from "./lib/window-kind";
import { MiniMonitorApp } from "./tools/process-monitor/MiniMonitorApp";
import { DictationHudApp } from "./tools/dictation/DictationHudApp";
import "./tools/dictation/dictation-hud.css";

// Wipe any leaked inline body styles before React mounts. Earlier
// builds toggled `body.style.userSelect = "none"` during pane drags,
// and a crash / hot-reload during a drag could leave that lock
// permanently in place — making the editor un-selectable until a full
// page reload. Clearing here happens once per actual page load, which
// is exactly what we want.
if (document.body.style.userSelect) document.body.style.userSelect = "";
if (document.body.style.cursor) document.body.style.cursor = "";

// Tauri windows that share this bundle short-circuit the heavy main
// app boot. Each one signals via `?window=<label>` (see
// `src/lib/window-kind.ts`).
//
//   - `main` (default)         → full router / provider tree.
//   - `pm-popover`             → tiny Process-Monitor panel.
//   - `dictation-hud`          → top-centre Dynamic-Island pill, only
//                                ever spawned by the macOS dictation
//                                feature; shouldn't pull in any
//                                other styles or providers.
const kind = getWindowKind();

if (kind !== "main") {
  // Transparent / frameless windows inherit the document background;
  // override the global body bg so the rounded frame shows. Both
  // popovers and the dictation HUD need this.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

// Tag the document root with the active window kind so per-window CSS
// (e.g. `dictation-hud.css`) can scope rules without needing a
// per-window stylesheet split. Currently used by the HUD to scope its
// `html, body { ... }` reset; without this gate those resets would
// stomp the main window's background.
document.documentElement.dataset.windowKind = kind;

const root = (() => {
  switch (kind) {
    case "pm-popover":
      return <MiniMonitorApp />;
    case "dictation-hud":
      return <DictationHudApp />;
    case "prmaster-popover":
    case "main":
    default:
      return <App />;
  }
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  root,
);
