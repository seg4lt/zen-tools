/**
 * Cleaner — top-level shell.
 *
 * The store provider (`CleanerStoreProvider`) lives in
 * `<AppProviders>` at the router root so the view's state survives
 * navigation between tools. This shell is a thin wrapper.
 *
 * The route entry in `src/router.tsx` mounts this component at
 * `/cleaner`.
 */

import { CleanerView } from "./CleanerView";

export function CleanerShell() {
  return <CleanerView />;
}
