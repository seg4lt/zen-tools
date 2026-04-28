/**
 * Registry of every "tool" hosted in the Zen Tools shell. Adding a tool
 * means appending one entry to this array and creating its route subtree.
 */
import type { LucideIcon } from "lucide-react";
import { Zap } from "lucide-react";

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
] as const;

/** The tool that should be the active default on first launch. */
export const DEFAULT_TOOL_ID = "http-runner";
