/**
 * Database Explorer — top-level shell. Mounted at `/database-explorer`.
 */

import { DatabaseExplorerView } from "./DatabaseExplorerView";
import { DbExplorerStoreProvider } from "./store/db-explorer-store";

export function DatabaseExplorerShell() {
  return (
    <DbExplorerStoreProvider>
      <DatabaseExplorerView />
    </DbExplorerStoreProvider>
  );
}
