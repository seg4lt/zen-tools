import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// Wipe any leaked inline body styles before React mounts. Earlier
// builds toggled `body.style.userSelect = "none"` during pane drags,
// and a crash / hot-reload during a drag could leave that lock
// permanently in place — making the editor un-selectable until a full
// page reload. Clearing here happens once per actual page load, which
// is exactly what we want.
if (document.body.style.userSelect) document.body.style.userSelect = "";
if (document.body.style.cursor) document.body.style.cursor = "";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
