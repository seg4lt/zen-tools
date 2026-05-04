/**
 * Terminal — top-level shell.
 *
 * The store provider (`TerminalStoreProvider`) lives in
 * `<AppProviders>` so the pane list survives navigation between
 * tools. The plugin-side NSView + PTY state is shared across mounts
 * regardless — this Shell is just the route entry.
 *
 * Mounted by `src/router.tsx` at `/terminal`. The route is also
 * gated behind `<DisabledGuard toolId="terminal">` so the user can
 * disable it from Settings just like every other tool.
 */

import { TerminalView } from "./TerminalView";

export function TerminalShell() {
  return <TerminalView />;
}
