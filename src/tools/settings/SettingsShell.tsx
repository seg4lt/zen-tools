/**
 * Settings — top-level shell. Mounted at `/settings` from `router.tsx`.
 * Settings is **not** in the `TOOLS` array; the route is reachable via
 * the gear icon in the title bar.
 */
import { SettingsView } from "./SettingsView";

export function SettingsShell() {
  return <SettingsView />;
}
