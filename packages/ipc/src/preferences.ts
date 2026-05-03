/**
 * Cross-tool preferences IPC.
 *
 * The persisted `Preferences` blob is shared by every tool (vim mode,
 * app zoom, tool order, working dirs, markdown vaults, cleaner scan
 * folders, db connections, …). Each tool owns the slice of fields
 * relevant to it and round-trips the full struct, so unknown fields
 * survive untouched. This module is the single source of truth for the
 * IPC wrappers and React-Query cache key.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Shared shape of the preferences blob. Keep in sync with
 * `src-tauri/src/commands/preferences.rs`. Per-tool fields are listed
 * with the `?` modifier so a tool only needs to declare the slice it
 * cares about — round-trip writes preserve everything else.
 */
export interface Preferences {
  workingDirs: string[];
  expandedPaths: string[];
  /** `true` when the editor's Vim keybindings should be active. */
  vimMode: boolean;
  /** Whole-app CSS zoom level on `<html>`. Default 1.0. */
  appZoom?: number;
  /** User-defined tool ordering for the title-bar pills. */
  toolOrder?: string[];
  /** Markdown vault folders. */
  markdownVaultDirs?: string[];
  /** Most recently opened markdown files (front of list = most recent). */
  markdownRecentFiles?: string[];
  /** Cleaner-tool scan-folder list. */
  cleanerScanFolders?: string[];
  /** Database Explorer SQL workspace folders. */
  sqlWorkspaceDirs?: string[];
  /**
   * Open-ended bucket for unknown fields. Other tools may persist
   * additional state under their own keys; we don't enumerate them
   * here so this type doesn't have to grow each time a new tool ships.
   */
  [key: string]: unknown;
}

/**
 * Single source of truth for the React Query key under which
 * `getPreferences` is cached. Every consumer that mutates a slice of
 * preferences invalidates this key so other consumers re-render.
 */
export const PREFERENCES_KEY = ["preferences"] as const;

/** Read the persisted preferences blob. */
export function getPreferences(): Promise<Preferences> {
  return invoke<Preferences>("get_preferences");
}

/** Write the full preferences blob (atomic on the Rust side). */
export function savePreferences(prefs: Preferences): Promise<void> {
  return invoke<void>("save_preferences", { prefs });
}
