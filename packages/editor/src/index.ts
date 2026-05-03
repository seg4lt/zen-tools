/**
 * Placeholder for the `@zen-tools/editor` package.
 *
 * Pending move (Phase 3.2):
 * - `src/components/code-editor/code-editor.tsx` — the themed
 *   CodeMirror 6 wrapper shared by HTTP runner, Database Explorer, and
 *   Markdown.
 * - `src/components/code-editor/index.ts`
 * - `src/tools/http-runner/lib/cm-theme.ts` — currently lives in
 *   http-runner's lib but is consumed by every editor host.
 *
 * The package should accept `isDark: boolean` as a prop so it has
 * zero `@tauri-apps/api` dependency.
 *
 * Until the migration lands this package exists only to reserve the
 * workspace slot.
 */
export {};
