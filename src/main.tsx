import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { isPmPopover } from "./lib/window-kind";
import { MiniMonitorApp } from "./tools/process-monitor/MiniMonitorApp";

// Wipe any leaked inline body styles before React mounts. Earlier
// builds toggled `body.style.userSelect = "none"` during pane drags,
// and a crash / hot-reload during a drag could leave that lock
// permanently in place — making the editor un-selectable until a full
// page reload. Clearing here happens once per actual page load, which
// is exactly what we want.
if (document.body.style.userSelect) document.body.style.userSelect = "";
if (document.body.style.cursor) document.body.style.cursor = "";

// The Tauri tray spawns a second small webview window
// (`label: "pm-popover"`, declared in `tauri.conf.json`) that loads
// `index.html?window=pm-popover`. Detecting the query param here lets
// the popover share this bundle without booting the entire router /
// provider tree (which is expensive and pointless for a 340x280 panel).
const pmPopover = isPmPopover();

if (pmPopover) {
  // Transparent tauri windows inherit the document background;
  // override the global body bg so the rounded popover frame shows.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pmPopover ? <MiniMonitorApp /> : <App />}</React.StrictMode>,
);
