/**
 * Re-export of the canonical preferences cache key from the
 * `@zen-tools/ipc` workspace package. Kept as a barrel here so the
 * existing `@/lib/preferences-key` import sites don't churn.
 *
 * New code should import directly from `@zen-tools/ipc`.
 */
export { PREFERENCES_KEY } from "@zen-tools/ipc";
