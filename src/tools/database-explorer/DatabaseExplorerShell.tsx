/**
 * Database Explorer — top-level shell. Mounted at `/database-explorer`.
 *
 * The store provider (`DbExplorerStoreProvider`) used to wrap this
 * shell, but it now lives in `<AppProviders>` at the router root so
 * per-connection state (active connection, results, open files,
 * lock telemetry, …) survives navigation between tool tabs. This
 * shell is a thin component-only wrapper.
 */

import { DatabaseExplorerView } from "./DatabaseExplorerView";

export function DatabaseExplorerShell() {
  return <DatabaseExplorerView />;
}
