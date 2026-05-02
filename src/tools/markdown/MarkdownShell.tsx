/**
 * Markdown — top-level shell.
 *
 * The store provider (`MarkdownStoreProvider`) lives in
 * `<AppProviders>` at the router root so the view's state survives
 * navigation between tools. This shell is a thin wrapper.
 *
 * The route entry in `src/router.tsx` mounts this component at
 * `/markdown`.
 */

import { MarkdownView } from "./MarkdownView";

export function MarkdownShell() {
  return <MarkdownView />;
}
