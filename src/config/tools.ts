/**
 * Registry of every "tool" hosted in the Zen Tools shell. Adding a tool
 * means appending one entry to this array and creating its route subtree.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Database,
  FileText,
  GitPullRequest,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";

/**
 * `true` when the current binary is running on macOS. Used to gate
 * macOS-only tools (currently just the Terminal — its native
 * `tauri-plugin-ghostty` crate is `cfg(target_os = "macos")` and
 * compiles to a no-op `init()` on other platforms, so the pill
 * should not appear there).
 *
 * We use `navigator.userAgent` rather than the Tauri `platform()`
 * API so this stays a synchronous module-level constant — the
 * `TOOLS` array is read during initial render and we don't want
 * the Terminal pill to flicker in / out across an async resolve.
 *
 * The check is conservative: in the unlikely case `navigator` isn't
 * around (SSR, very old WebKit), it falls back to false → no Terminal
 * pill, which is the safer default than crashing the host.
 */
const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

export interface Tool {
  /** Stable identifier (used for route segments and persistence keys). */
  readonly id: string;
  /** Human-readable label shown in the segmented pill. */
  readonly label: string;
  /** Lucide icon component rendered inside the pill. */
  readonly icon: LucideIcon;
  /** Top-level route under which this tool lives. */
  readonly route: string;
  /** Optional short description for tooltips. */
  readonly description?: string;
}

export const TOOLS: readonly Tool[] = [
  {
    id: "http-runner",
    label: "HTTP Runner",
    icon: Zap,
    route: "/http-runner",
    description: "IntelliJ-style HTTP file runner with performance testing",
  },
  {
    id: "process-monitor",
    label: "Process Monitor",
    icon: Activity,
    route: "/process-monitor",
    description: "Monitor CPU and memory of system process trees",
  },
  {
    id: "cleaner",
    label: "Cleaner",
    icon: Sparkles,
    route: "/cleaner",
    description: "Reclaim disk — clean repos & purge dev caches",
  },
  {
    id: "markdown",
    label: "Markdown",
    icon: FileText,
    route: "/markdown",
    description: "Obsidian-lite vault editor with vim, paste-to-image, wikilinks",
  },
  {
    id: "database-explorer",
    label: "Database",
    icon: Database,
    route: "/database-explorer",
    description: "DataGrip-lite — query Postgres & MSSQL with syntax highlighting",
  },
  {
    id: "prmaster",
    label: "PRMaster",
    icon: GitPullRequest,
    route: "/prmaster",
    description:
      "GitHub PR review dashboard — Mine, To Review, Done, Conversations, AI Summary",
  },
  // Native macOS terminal (Ghostty). Only registered on macOS — the
  // `tauri-plugin-ghostty` crate is `cfg(target_os = "macos")` and
  // exposes a no-op `init()` on other platforms.
  ...(IS_MACOS
    ? ([
        {
          id: "terminal",
          label: "Terminal",
          icon: TerminalSquare,
          route: "/terminal",
          description:
            "Native Ghostty terminal — multi-pane, GPU-accelerated, reads your ~/.config/ghostty/config",
        },
      ] as const)
    : ([] as const)),
] as const;

/** The tool that should be the active default on first launch. */
export const DEFAULT_TOOL_ID = "http-runner";
