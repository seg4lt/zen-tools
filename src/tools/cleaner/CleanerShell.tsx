/**
 * Cleaner — top-level shell.
 *
 * Mirrors the HTTP Runner / Process Monitor pattern: provide the
 * tool-local store at the top, then render the main view inside it.
 * The route entry in `src/router.tsx` mounts this component at `/cleaner`.
 */

import { CleanerView } from "./CleanerView";
import { CleanerStoreProvider } from "./store/cleaner-store";

export function CleanerShell() {
  return (
    <CleanerStoreProvider>
      <CleanerView />
    </CleanerStoreProvider>
  );
}
