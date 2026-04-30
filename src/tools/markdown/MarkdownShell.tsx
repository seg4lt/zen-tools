/**
 * Markdown — top-level shell.  Same convention as the cleaner and
 * process-monitor tools: provide the per-tool store, then render the
 * main view inside it.  The route entry in `src/router.tsx` mounts
 * this component at `/markdown`.
 */

import { MarkdownView } from "./MarkdownView";
import { MarkdownStoreProvider } from "./store/markdown-store";

export function MarkdownShell() {
  return (
    <MarkdownStoreProvider>
      <MarkdownView />
    </MarkdownStoreProvider>
  );
}
