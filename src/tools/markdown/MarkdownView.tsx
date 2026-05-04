/**
 * Two-pane layout: vault sidebar | editor.
 *
 * Reads everything from the store — the editor host gets value-getter
 * callbacks so it doesn't have to remount when the open file changes.
 * `setValue` is fired through the imperative handle whenever the
 * store's `currentFile.path` changes.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Keyboard, Loader2, PanelLeftOpen, Save } from "lucide-react";
import { Button } from "@zen-tools/ui";
import { DragHandle } from "@/components/drag-handle";
import { useVimMode } from "@/hooks/use-vim-mode";
import { cn } from "@zen-tools/ui";
import {
  SplitLayout,
  leafIds,
  useJumpList,
  useWorkspaceVim,
  type JumpEntry,
  type WorkspaceContext,
} from "@zen-tools/editor";
import { useMarkdownWorkspace } from "./store/markdown-workspace";
import { VaultSidebar } from "./components/vault-sidebar";
import { SearchPalette } from "./components/search-palette";
import { EmptyState } from "./components/empty-state";
import { TabStrip } from "./components/tab-strip";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "./components/markdown-editor";
// Excalidraw is ~3 MB worth of canvas + utility code.  Lazy-load it
// behind a Suspense boundary so users who never open a drawing don't
// pay the bundle cost.
const ExcalidrawEditor = lazy(
  () => import("./components/excalidraw-editor"),
);
import { useMarkdownStore, type TabState } from "./store/markdown-store";
import { useOpenFile } from "./hooks/use-open-file";
import { useAutoSave } from "@/hooks/use-auto-save";
import { markdownTauri } from "./lib/tauri";
import { useVaults } from "./hooks/use-vaults";
import { useMarkdownKeyboardNav } from "./hooks/use-keyboard-nav";
import { basename, basenameNoExt, dirname, normalizePath } from "./lib/tauri";
import { useTheme } from "@/hooks/use-theme";

export function MarkdownView() {
  // Wire up Cmd+O / Cmd+Shift+O at this level so the listener
  // lifecycles with the view.
  useMarkdownKeyboardNav();

  const { state, dispatch } = useMarkdownStore();
  const { openFile, saveCurrent, resolveWikilink } = useOpenFile();
  const { addVault, refresh: refreshVaults } = useVaults();
  // One editor handle per leaf. Each split has its own CodeMirror
  // instance — separate cursor, scroll, and undo history.
  const leafHandlesRef = useRef<Map<string, MarkdownEditorHandle>>(new Map());

  // Split workspace state — owns `splitTree`, `focusedLeafId`, and
  // the `:vsplit` / `:hsplit` / `:q` / `Ctrl+W` actions. Hoisted
  // into `MarkdownWorkspaceProvider` (rendered inside
  // `MarkdownStoreProvider` at `<AppProviders>`) so the layout
  // survives navigation between zen-tools tools — without that
  // hoist, switching to e.g. Terminal and back collapsed all
  // splits because `useSplitWorkspace` was called per `MarkdownView`
  // mount and reset on every remount.
  const { workspace, leafTabs, setLeafTabs } = useMarkdownWorkspace();
  const jumpList = useJumpList();

  // Local-only ref — bookkeeping for the focus-sync effect below.
  // Doesn't need to persist across MarkdownView remounts: when we
  // remount we should re-sync the active tab to whatever the
  // (persistent) focused leaf currently maps to.
  const prevFocusedLeafRef = useRef(workspace.focusedLeafId);

  // Effect A — focus change syncs `state.activeTabId` to the new
  // focused leaf's stored tab. New (just-split) leaves with no
  // stored tab inherit from the previously-focused leaf or fall
  // back to the current `activeTabId`.
  useEffect(() => {
    const newFocused = workspace.focusedLeafId;
    const oldFocused = prevFocusedLeafRef.current;
    prevFocusedLeafRef.current = newFocused;
    if (newFocused === oldFocused) return;
    setLeafTabs((prev) => {
      const stored = prev[newFocused];
      if (stored) {
        if (stored !== state.activeTabId) {
          dispatch({ type: "selectTab", id: stored });
        }
        return prev;
      }
      const inherited = prev[oldFocused] ?? state.activeTabId;
      if (!inherited) return prev;
      return { ...prev, [newFocused]: inherited };
    });
    // Only fires when the focused leaf id changes. We deliberately
    // don't react to `state.activeTabId` here — that's effect B.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.focusedLeafId]);

  // Effect B — `state.activeTabId` changes (sidebar click, search
  // palette, openFile, tab strip click) all funnel through the
  // store. Whatever the cause, the *focused* leaf is the one whose
  // tab should follow.
  useEffect(() => {
    if (!state.activeTabId) return;
    setLeafTabs((prev) => {
      if (prev[workspace.focusedLeafId] === state.activeTabId) return prev;
      return { ...prev, [workspace.focusedLeafId]: state.activeTabId! };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTabId]);

  // Effect C — prune `leafTabs` entries for leaves that no longer
  // exist in the tree (e.g. after `:q` closes a split) and entries
  // pointing to closed tabs.
  useEffect(() => {
    const validLeaves = new Set(leafIds(workspace.tree));
    const validTabs = new Set(state.tabs.map((t) => t.id));
    setLeafTabs((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!validLeaves.has(k)) {
          changed = true;
          continue;
        }
        if (!validTabs.has(v)) {
          changed = true;
          continue;
        }
        next[k] = v;
      }
      return changed ? next : prev;
    });
  }, [workspace.tree, state.tabs]);

  // Lookup helper — the tab object a given leaf is showing. Falls
  // back to the global `activeTab(state)` when no per-leaf entry is
  // recorded yet (initial mount, brand-new leaf).
  const tabForLeaf = useCallback(
    (leafId: string) => {
      const id = leafTabs[leafId] ?? state.activeTabId;
      if (!id) return null;
      return state.tabs.find((t) => t.id === id) ?? null;
    },
    [leafTabs, state.activeTabId, state.tabs],
  );

  // Tab the focused leaf is showing — drives header chrome, save
  // button enable/disable, autosave key, etc. Replaces the old
  // `activeTab(state)` call.
  const tab = tabForLeaf(workspace.focusedLeafId);
  const isExcalidraw = tab?.kind === "excalidraw";
  const { theme } = useTheme();

  // Push a jump-list entry whenever the focused leaf's active tab
  // changes — captures both palette / sidebar file switches and
  // `Ctrl+W h/j/k/l` movements between splits.
  useEffect(() => {
    if (!tab) return;
    const handle = leafHandlesRef.current.get(workspace.focusedLeafId);
    const cursorOffset = handle?.getCursorOffset() ?? 0;
    jumpList.push({
      leafId: workspace.focusedLeafId,
      tabId: tab.id,
      cursorOffset,
    });
  }, [tab?.id, workspace.focusedLeafId, jumpList]);

  // Goto-line side-effect — only applies to the focused leaf.
  useEffect(() => {
    const goto = state.pendingGotoLine;
    if (goto == null) return;
    const focused = leafHandlesRef.current.get(workspace.focusedLeafId);
    requestAnimationFrame(() => {
      focused?.scrollToLine(goto);
      focused?.focus();
      dispatch({ type: "clearGotoLine" });
    });
  }, [state.pendingGotoLine, dispatch, workspace.focusedLeafId]);

  // Refocus the focused leaf whenever the search palette closes —
  // covers two cases:
  //   1. User picks the *same* file that's already open. `selectTab`
  //      with no `gotoLine` changes neither `activeTabId` nor
  //      `pendingGotoLine`, so none of the other focus-driving
  //      effects fire and the editor would silently lose focus to
  //      the palette dialog's body.
  //   2. User dismisses with Esc. They were typing before, they
  //      probably want to type again — return them to the editor
  //      instead of leaving focus on the document body.
  const prevSearchOpenRef = useRef(state.searchOpen);
  useEffect(() => {
    const was = prevSearchOpenRef.current;
    prevSearchOpenRef.current = state.searchOpen;
    if (was && !state.searchOpen) {
      requestAnimationFrame(() => {
        leafHandlesRef.current.get(workspace.focusedLeafId)?.focus();
      });
    }
  }, [state.searchOpen, workspace.focusedLeafId]);

  // Vim toggle plumbing — shared `useVimMode` hook reads + writes the
  // same prefs blob every tool reads, so the toggle propagates
  // instantly to the HTTP runner / Database Explorer editors too.
  const { vimMode, setVimMode } = useVimMode();

  // ── Deterministic per-leaf dispatch ────────────────────────────
  //
  // Two refs hold the workspace's per-leaf state, kept in sync with
  // committed state via `useLayoutEffect`. `useLayoutEffect` fires
  // synchronously after every commit and BEFORE the browser paints
  // or processes the next event — so any keystroke that arrives
  // between renders sees fully up-to-date refs.
  //
  // The change/save callbacks are deliberately stable (deps reference
  // only `dispatch` and the also-stable autoSave.cancel). That means
  // `CodeEditor`'s internal `onChangeRef` captures them at mount and
  // never has to be re-synced — eliminating the
  // `useEffect`-runs-after-paint window where a keystroke could fire
  // against a stale handler.
  //
  // Callbacks accept `leafId` (a stable prop on each leaf component)
  // and look up the leaf's *current* tab via `leafTabsRef`. So no
  // matter when the keystroke fires, it always dispatches to the
  // tab the leaf is showing right now.
  const leafTabsRef = useRef(leafTabs);
  const tabsRef = useRef(state.tabs);
  useLayoutEffect(() => {
    leafTabsRef.current = leafTabs;
    tabsRef.current = state.tabs;
  });

  const onLeafChange = useCallback(
    (leafId: string, doc: string) => {
      const tabId = leafTabsRef.current[leafId];
      if (!tabId) return;
      dispatch({ type: "editDoc", id: tabId, doc });
    },
    [dispatch],
  );

  // Shared trailing-edge autosave — same hook the SQL + http editors
  // use. Hits disk directly (path-aware) so tab-switching mid-save
  // doesn't clobber the wrong tab's dirty flag.
  const autoSave = useAutoSave({
    key: !isExcalidraw && tab ? tab.path : null,
    content: tab?.doc ?? "",
    dirty: tab?.dirty ?? false,
    save: useCallback(
      async (path: string, content: string) => {
        await markdownTauri.writeFile(path, content);
        dispatch({ type: "markSaved", path });
      },
      [dispatch],
    ),
  });

  // (The chrome Save button still goes through `saveCurrent()` — a
  // button click can't race a focus transition the way an in-editor
  // ⌘S can, so the activeTab-keyed path is fine there.)

  // Per-leaf save — keyed by leafId, looks up the path through
  // `leafTabsRef` + `tabsRef` at fire time. Stable across renders
  // for the same reason as `onLeafChange`: by depending only on
  // `autoSaveCancel` (a stable function from useAutoSave) and
  // `dispatch`, the callback identity never changes, so the inner
  // editor's stable `onSaveRef` always points at the right handler.
  const autoSaveCancel = autoSave.cancel;
  const onLeafSave = useCallback(
    async (leafId: string, doc: string) => {
      const tabId = leafTabsRef.current[leafId];
      if (!tabId) return;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      autoSaveCancel();
      try {
        await markdownTauri.writeFile(tab.path, doc);
        dispatch({ type: "markSaved", path: tab.path });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[markdown] save failed", err);
      }
    },
    [autoSaveCancel, dispatch],
  );

  const getDocDir = useCallback(
    () => (tab ? dirname(tab.path) : ""),
    [tab?.path],
  );

  const getCurrentPath = useCallback(
    () => tab?.path ?? null,
    [tab?.path],
  );

  // The link autocomplete in the live-preview pane needs the open
  // vaults so it can fan out an fff-search query across them.  Stable
  // callback keyed on `state.vaults` — fff itself owns the warm
  // index, so this only affects which vault list the source asks.
  const getVaults = useCallback(() => state.vaults, [state.vaults]);

  // Wikilink autocomplete: every `.md` basename across all vaults.
  // Memoised to avoid rebuilding on each keystroke.
  const getCandidates = useCallback(() => {
    const seen = new Set<string>();
    for (const vault of Object.values(state.files)) {
      for (const item of vault.items) {
        if (item.isDir) continue;
        seen.add(basenameNoExt(item.path));
      }
    }
    return Array.from(seen).sort();
  }, [state.files]);

  // Split-aware "go to file" helper used by `gf` / `gd` and by
  // wikilink / link clicks. Behaviour:
  //
  //   1. If the file is already open in *any* split, move focus
  //      to that split (first match wins). The user lands on the
  //      file they wanted without duplicating it across panes.
  //   2. Otherwise, open it in the focused split as a new tab —
  //      same as picking the file from the sidebar.
  const openFileInWorkspace = useCallback(
    (rawPath: string) => {
      const normalized = normalizePath(rawPath);
      // Pass 1 — find a leaf already showing this file.
      for (const [leafId, tabId] of Object.entries(leafTabs)) {
        const t = state.tabs.find((tab) => tab.id === tabId);
        if (t && t.path === normalized) {
          if (leafId !== workspace.focusedLeafId) {
            workspace.setFocus(leafId);
          }
          return;
        }
      }
      // Pass 2 — not visible anywhere; open in the focused leaf.
      // `openFile` itself dedupes against `state.tabs` so an already-
      // opened-but-not-displayed tab gets reused without re-reading
      // from disk.
      void openFile(normalized);
    },
    [leafTabs, state.tabs, workspace, openFile],
  );

  const onWikilinkOpen = useCallback(
    (label: string) => {
      const path = resolveWikilink(label);
      if (path) {
        openFileInWorkspace(path);
      } else {
        // Ambiguous or missing — fall back to the search palette in
        // file mode so the user can pick from candidates.
        dispatch({
          type: "setSearchPalette",
          open: true,
          mode: "files",
        });
      }
    },
    [openFileInWorkspace, resolveWikilink, dispatch],
  );

  /**
   * Resolve + dispatch a `[label](url)` link.  Local relative `.md`
   * paths open in the editor; everything else (external URLs,
   * non-markdown attachments) is left for a future iteration — we
   * just log so the user can see we received the click.
   */
  const onLinkOpen = useCallback(
    (rawUrl: string) => {
      // Strip any anchor hash; `foo.md#heading` should still resolve
      // to `foo.md`.
      const url = rawUrl.split("#")[0]?.trim() ?? "";
      if (!url) return;
      // External URLs — let the user know we don't open them yet.
      if (/^(https?:|mailto:|tel:|ftp:)/i.test(url)) {
        console.info("[markdown] external link click ignored:", url);
        return;
      }
      // Decode `%20` and friends so a path like `My%20Notes/foo.md`
      // resolves correctly against the filesystem.
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // Leave as-is on malformed encoding.
      }
      // Resolve to an absolute path.
      let target = decoded;
      if (decoded.startsWith("file://")) {
        target = decoded.slice("file://".length);
      } else if (!decoded.startsWith("/")) {
        const dir = tab ? dirname(tab.path) : "";
        if (!dir) {
          console.warn(
            "[markdown] relative link with no open document:",
            url,
          );
          return;
        }
        target = `${dir}/${decoded}`;
      }
      // Collapse `./` and `../` segments so the backend never sees
      // literal dot-segments — a `../assets/foo.md` link from
      // `/notes/sub/page.md` becomes `/notes/assets/foo.md`.
      target = normalizePath(target);
      // Markdown OR Excalidraw drawings open in the editor — the
      // tab kind determines which pane mounts (CodeMirror vs the
      // drawing canvas).  Plain images would render as garbage in
      // CodeMirror, so they remain ignored.
      const isMarkdownLike = /\.(md|markdown|mdown|mkd)$/i.test(target);
      const isExcalidrawLink = /\.excalidraw\.(svg|png)$/i.test(target);
      if (!isMarkdownLike && !isExcalidrawLink) {
        console.info(
          "[markdown] non-text link click ignored (no app handler yet):",
          target,
        );
        return;
      }
      openFileInWorkspace(target);
    },
    [openFileInWorkspace, tab?.path],
  );

  // After every paste lands, re-walk the open vaults so the new file
  // surfaces in the sidebar without requiring a manual refresh.
  // Fire-and-forget — the user already sees the inserted markdown
  // and the inline image render via the editor's live preview.
  const onImageSaved = useCallback(() => {
    void refreshVaults();
  }, [refreshVaults]);

  // Toggle the global `vim_mode` pref. The hook's `setVimMode`
  // round-trips through `getPreferences` + `savePreferences` and
  // invalidates the React Query cache, so other tools' `useVimMode`
  // observers re-render with the new value on the next tick.
  const onToggleVim = useCallback(async () => {
    try {
      await setVimMode(!vimMode);
    } catch (err) {
      console.error("[markdown] toggle vim failed", err);
    }
  }, [vimMode, setVimMode]);

  // Workspace context — bridges `:q` / `:vsplit` / `:hsplit` ex-commands
  // to the split workspace. `:q` closes the focused split when there
  // are multiple leaves; otherwise falls back to closing the active
  // tab so the existing one-leaf semantics still work.
  const workspaceContext = useMemo<WorkspaceContext>(
    () => ({
      closeActive: () => {
        const closed = workspace.closeFocused();
        if (closed) return;
        if (state.activeTabId) {
          dispatch({ type: "closeTab", id: state.activeTabId });
        }
      },
      split: (direction) => workspace.split(direction),
      moveFocus: (dir) => workspace.moveFocus(dir),
    }),
    [workspace, state.activeTabId, dispatch],
  );
  useWorkspaceVim(workspaceContext);

  // Jump-list back/forward — looks up the entry's tab id and
  // refocuses it. Returns `true` when a jump was performed so the
  // editor's `Ctrl+O`/`Ctrl+I` keymap doesn't fall through to vim.
  const navigateToJump = useCallback(
    (entry: JumpEntry | null): boolean => {
      if (!entry) return false;
      if (entry.tabId && entry.tabId !== state.activeTabId) {
        dispatch({ type: "selectTab", id: entry.tabId });
      }
      if (entry.leafId !== workspace.focusedLeafId) {
        workspace.setFocus(entry.leafId);
      }
      requestAnimationFrame(() => {
        const handle = leafHandlesRef.current.get(entry.leafId);
        if (handle && entry.cursorOffset > 0) {
          // Cursor offset is 0-based; `scrollToLine` is 1-based.
          // Best-effort line resolution via the current doc.
          const value = handle.getValue();
          const before = value.slice(0, entry.cursorOffset);
          const line = before.split("\n").length;
          handle.scrollToLine(line);
        }
        handle?.focus();
      });
      return true;
    },
    [state.activeTabId, dispatch, workspace],
  );
  const onJumpBack = useCallback(
    () => navigateToJump(jumpList.back()),
    [jumpList, navigateToJump],
  );
  const onJumpForward = useCallback(
    () => navigateToJump(jumpList.forward()),
    [jumpList, navigateToJump],
  );

  const hasVaults = state.vaults.length > 0;
  const hasFile = !!tab;

  // Drag-resizable sidebar — local state only, mirrors the
  // database-explorer / http-runner pattern. Default mirrors the
  // previous hard-coded `w-64` (256 px).
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
        <span className="text-sm font-medium">Markdown</span>
        {tab ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px] text-muted-foreground/80",
              tab.dirty && "text-amber-600 dark:text-amber-300",
            )}
            title={tab.path}
          >
            {tab.dirty ? "●" : ""}{" "}
            {/* Excalidraw + non-`.md` markdown variants need the full
             *  basename so the suffix is visible.  Pre-existing
             *  behaviour for `*.md` was `<stem>.md`, preserved. */}
            {isExcalidraw
              ? basename(tab.path)
              : `${basenameNoExt(tab.path)}.md`}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {tab ? (
            <Button
              size="xs"
              variant="ghost"
              title="Save (Cmd+S / :w)"
              onClick={() => void saveCurrent()}
              className="gap-1"
              disabled={!tab.dirty}
            >
              <Save className="size-3" /> Save
            </Button>
          ) : null}
          {/* Vim mode applies only to the CodeMirror text editor —
           *  hide the toggle in the Excalidraw drawing pane where
           *  the chrome would just be confusing. */}
          {!isExcalidraw && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void onToggleVim()}
              title={
                vimMode
                  ? "Vim mode is ON — click to disable globally"
                  : "Vim mode is OFF — click to enable globally"
              }
              className={cn(
                "gap-1 font-mono uppercase tracking-wider",
                vimMode
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              <Keyboard className="size-3" /> vim{" "}
              {vimMode ? "on" : "off"}
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? (
          <div className="flex w-7 shrink-0 flex-col items-center border-r bg-muted/20 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              title="Show vaults"
              onClick={() => setSidebarCollapsed(false)}
            >
              <PanelLeftOpen className="size-3" />
            </Button>
          </div>
        ) : (
          <>
            <aside
              className="flex shrink-0 flex-col"
              style={{ width: sidebarWidth }}
            >
              <VaultSidebar onCollapse={() => setSidebarCollapsed(true)} />
            </aside>
            <DragHandle
              direction="x"
              initial={sidebarWidth}
              min={180}
              max={520}
              onResize={setSidebarWidth}
            />
          </>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasFile ? (
            isExcalidraw ? (
              // Drawings get a remount per tab id so the lazy
              // import + initial-data load run once per file.
              // The fallback shows while the ~3 MB chunk loads.
              <Suspense
                fallback={
                  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" /> loading
                    drawing…
                  </div>
                }
              >
                <ExcalidrawEditor
                  key={tab!.id}
                  path={tab!.path}
                  theme={theme}
                  onDirty={() =>
                    dispatch({
                      type: "editDoc",
                      doc: "__excalidraw_dirty__",
                    })
                  }
                  // Excalidraw hands us either a serialised SVG
                  // string or PNG `Uint8Array` depending on the
                  // file's extension — `saveCurrent` routes both.
                  onSave={(data) => void saveCurrent(data)}
                />
              </Suspense>
            ) : (
              // One CodeMirror instance per split leaf — each gets
              // its own cursor, scroll position and undo history.
              // Editors converge on the active tab's `doc` via
              // `setValue` (CodeEditor's no-op guard prevents
              // self-feedback when one leaf's onChange propagates
              // through the store back to itself).
              <SplitLayout
                root={workspace.tree}
                focusedLeafId={workspace.focusedLeafId}
                onFocusLeaf={workspace.setFocus}
                onResize={workspace.resize}
                renderLeaf={(leafId, focused) => {
                  // Each leaf renders ITS OWN tab. Different leaves
                  // can show different files independently.
                  const leafTab = tabForLeaf(leafId);
                  return (
                    <MarkdownLeafShell
                      leafId={leafId}
                      focused={focused}
                      leafTab={leafTab}
                      tabs={state.tabs}
                      onSelectTab={(tabId) => {
                        // Click in a leaf's tab strip: focus that
                        // leaf AND switch its active tab. Update
                        // both the per-leaf store and the global
                        // store synchronously so effects converge.
                        workspace.setFocus(leafId);
                        setLeafTabs((prev) =>
                          prev[leafId] === tabId
                            ? prev
                            : { ...prev, [leafId]: tabId },
                        );
                        if (state.activeTabId !== tabId) {
                          dispatch({ type: "selectTab", id: tabId });
                        }
                      }}
                      onCloseTab={(tabId) => {
                        dispatch({ type: "closeTab", id: tabId });
                      }}
                      onChange={onLeafChange}
                      onSave={onLeafSave}
                      onMoveFocus={workspace.moveFocus}
                      onJumpBack={onJumpBack}
                      onJumpForward={onJumpForward}
                      vimMode={vimMode}
                      getDocDir={getDocDir}
                      getCurrentPath={getCurrentPath}
                      getVaults={getVaults}
                      getWikilinkCandidates={getCandidates}
                      onWikilinkOpen={onWikilinkOpen}
                      onLinkOpen={onLinkOpen}
                      onImageSaved={onImageSaved}
                      registerHandle={(h) => {
                        if (h) leafHandlesRef.current.set(leafId, h);
                        else leafHandlesRef.current.delete(leafId);
                      }}
                    />
                  );
                }}
              />
            )
          ) : (
            <EmptyState
              hasVaults={hasVaults}
              onPickVault={() => void addVault()}
            />
          )}
        </div>
      </div>
      <SearchPalette />
    </div>
  );
}

/**
 * One leaf of the split workspace — a `<MarkdownEditor>` showing
 * *this leaf's* tab (which may differ from the active tab in
 * sibling leaves). Owns its own handle ref + focus ring; the
 * parent only orchestrates state.
 */
interface MarkdownLeafShellProps {
  leafId: string;
  focused: boolean;
  /** The tab this leaf is currently showing. `null` for empty leaves. */
  leafTab: TabState | null;
  /** Global open tabs — same list rendered in every leaf's strip. */
  tabs: TabState[];
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  /**
   * Edit handler. Stable across renders. Identifies the leaf by its
   * stable `leafId`; the parent looks up which tab the leaf is
   * showing through a layout-effect-synced ref so the dispatch is
   * fully deterministic regardless of React effect timing.
   */
  onChange: (leafId: string, doc: string) => void;
  /** Save handler — same deterministic-by-leafId contract. */
  onSave: (leafId: string, doc: string) => Promise<void> | void;
  onMoveFocus: (dir: "h" | "j" | "k" | "l") => void;
  onJumpBack: () => boolean;
  onJumpForward: () => boolean;
  vimMode: boolean;
  getDocDir: () => string;
  getCurrentPath: () => string | null;
  getVaults: () => string[];
  getWikilinkCandidates: () => string[];
  onWikilinkOpen: (label: string) => void;
  onLinkOpen: (url: string) => void;
  onImageSaved: () => void;
  registerHandle: (handle: MarkdownEditorHandle | null) => void;
}

function MarkdownLeafShell({
  leafId,
  focused,
  leafTab,
  tabs,
  onSelectTab,
  onCloseTab,
  onChange,
  onSave,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  vimMode,
  getDocDir,
  getCurrentPath,
  getVaults,
  getWikilinkCandidates,
  onWikilinkOpen,
  onLinkOpen,
  onImageSaved,
  registerHandle,
}: MarkdownLeafShellProps) {
  const handleRef = useRef<MarkdownEditorHandle | null>(null);
  const lastTabIdRef = useRef<string | null>(null);

  // Register on mount, unregister on unmount, so the parent can
  // address this leaf's editor (jump-list scroll, focus, etc.).
  useEffect(() => {
    registerHandle(handleRef.current);
    return () => registerHandle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pump this leaf's tab content into its editor whenever the tab
  // id or doc changes. `setValue` is a no-op when content already
  // matches — so a sibling leaf's edit propagating through the
  // shared store updates *this* leaf only when this leaf shows the
  // same tab; when this leaf shows a *different* tab, its content
  // is unaffected.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (!leafTab) {
      handle.setValue("");
      lastTabIdRef.current = null;
      return;
    }
    handle.setValue(leafTab.doc);
    if (lastTabIdRef.current !== leafTab.id) {
      lastTabIdRef.current = leafTab.id;
      // Tab switch: focus this leaf if it owns input focus, so the
      // user lands in the new file's editor rather than chrome.
      if (focused) {
        requestAnimationFrame(() => handle.focus());
      }
    }
    // We deliberately don't include `focused` in deps — focus
    // tracking is handled by its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafTab?.id, leafTab?.doc]);

  // When this leaf becomes the focused one (e.g. after `Ctrl+W l`),
  // pull DOM focus into its editor so subsequent keystrokes land
  // here.
  useEffect(() => {
    if (focused) handleRef.current?.focus();
  }, [focused]);

  // Wrap the parent's `(leafId, doc)` callbacks into the editor's
  // `(doc) => void` shape. `leafId` is a stable prop and the parent
  // callbacks are stable, so these wrappers are also stable —
  // `CodeEditor`'s internal `onChangeRef` / `onSaveRef` capture
  // them at mount and never go stale, fully closing the
  // `useEffect`-after-paint race window.
  const handleEditorChange = useCallback(
    (doc: string) => onChange(leafId, doc),
    [leafId, onChange],
  );
  const handleEditorSave = useCallback(
    (doc: string) => {
      void onSave(leafId, doc);
    },
    [leafId, onSave],
  );

  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 flex-col",
        focused ? "outline outline-1 outline-primary/40 -outline-offset-1" : "",
      )}
    >
      <TabStrip
        tabs={tabs}
        activeTabId={leafTab?.id ?? null}
        onSelect={onSelectTab}
        onClose={onCloseTab}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <MarkdownEditor
          imperativeRef={handleRef}
          value={leafTab?.doc ?? ""}
          onChange={handleEditorChange}
          onSave={handleEditorSave}
          onMoveFocus={onMoveFocus}
          onJumpBack={onJumpBack}
          onJumpForward={onJumpForward}
          vimMode={vimMode}
          getDocDir={getDocDir}
          getCurrentPath={getCurrentPath}
          getVaults={getVaults}
          getWikilinkCandidates={getWikilinkCandidates}
          onWikilinkOpen={onWikilinkOpen}
          onLinkOpen={onLinkOpen}
          onImageSaved={onImageSaved}
        />
      </div>
    </div>
  );
}
