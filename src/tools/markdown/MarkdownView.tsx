/**
 * Two-pane layout: vault sidebar | editor.
 *
 * Reads everything from the store — the editor host gets value-getter
 * callbacks so it doesn't have to remount when the open file changes.
 * `setValue` is fired through the imperative handle whenever the
 * store's `currentFile.path` changes.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Loader2, PanelLeftOpen, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DragHandle } from "@/components/drag-handle";
import { tauri as httpTauri } from "@/tools/http-runner/lib/tauri";
import { cn } from "@/lib/utils";
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
import { activeTab, useMarkdownStore } from "./store/markdown-store";
import { useOpenFile } from "./hooks/use-open-file";
import { useAutoSave } from "@/hooks/use-auto-save";
import { markdownTauri } from "./lib/tauri";
import { useVaults } from "./hooks/use-vaults";
import { useMarkdownKeyboardNav } from "./hooks/use-keyboard-nav";
import { basename, basenameNoExt, dirname } from "./lib/tauri";
import { useTheme } from "@/hooks/use-theme";

export function MarkdownView() {
  // Wire up Cmd+O / Cmd+Shift+O at this level so the listener
  // lifecycles with the view.
  useMarkdownKeyboardNav();

  const { state, dispatch } = useMarkdownStore();
  const { openFile, saveCurrent, resolveWikilink } = useOpenFile();
  const { addVault, refresh: refreshVaults } = useVaults();
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const queryClient = useQueryClient();

  const tab = activeTab(state);
  const isExcalidraw = tab?.kind === "excalidraw";
  const { theme } = useTheme();

  // Re-sync the editor's buffer whenever the *active tab id* changes
  // (i.e. user switched files), and consume any pending goto-line
  // request the search palette dropped in.
  //
  // Skipped entirely for Excalidraw tabs: the CodeMirror editor isn't
  // mounted, the imperative ref is null, and `tab.doc` is an empty
  // sentinel.  The drawing pane manages its own load/save lifecycle.
  const lastTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (isExcalidraw) {
      // Track the active tab id even when CodeMirror is unmounted so
      // a switch back to a markdown tab still triggers a `setValue`
      // sync rather than thinking nothing has changed.
      lastTabIdRef.current = tab?.id ?? null;
      return;
    }
    const handle = editorRef.current;
    if (!handle) return;

    if (!tab) {
      handle.setValue("");
      lastTabIdRef.current = null;
      return;
    }

    const tabSwitched = lastTabIdRef.current !== tab.id;
    if (tabSwitched) {
      handle.setValue(tab.doc);
      lastTabIdRef.current = tab.id;
    }

    // `requestAnimationFrame` lets CodeMirror's own state settle
    // first; calling focus() / scrollTo() inline can race the
    // setValue dispatch above.
    const goto = state.pendingGotoLine;
    requestAnimationFrame(() => {
      if (tabSwitched) handle.focus();
      if (goto != null) {
        handle.scrollToLine(goto);
        handle.focus();
        dispatch({ type: "clearGotoLine" });
      }
    });
  }, [tab?.id, tab?.doc, isExcalidraw, state.pendingGotoLine, dispatch]);

  // Vim toggle plumbing — same prefs key as http-runner.  Lazy load,
  // default `true` to match the tool's historical behaviour.
  const { data: prefs } = useQuery({
    queryKey: ["preferences"],
    queryFn: () => httpTauri.getPreferences(),
    staleTime: Infinity,
  });
  const vimMode = prefs?.vimMode ?? true;

  const onChange = useCallback(
    (doc: string) => dispatch({ type: "editDoc", doc }),
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

  const onSave = useCallback(
    (doc: string) => {
      // ⌘S beats the autosave timer to it — collapse the debounce.
      autoSave.cancel();
      void saveCurrent(doc);
    },
    [autoSave, saveCurrent],
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

  const onWikilinkOpen = useCallback(
    (label: string) => {
      const path = resolveWikilink(label);
      if (path) {
        void openFile(path);
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
    [openFile, resolveWikilink, dispatch],
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
      void openFile(target);
    },
    [openFile, tab?.path],
  );

  // After every paste lands, re-walk the open vaults so the new file
  // surfaces in the sidebar without requiring a manual refresh.
  // Fire-and-forget — the user already sees the inserted markdown
  // and the inline image render via the editor's live preview.
  const onImageSaved = useCallback(() => {
    void refreshVaults();
  }, [refreshVaults]);

  // Toggle the global `vim_mode` pref.  Writes through Tauri so
  // every tool (http-runner included) picks up the new value next
  // render via its `["preferences"]` query.
  const onToggleVim = useCallback(async () => {
    if (!prefs) return;
    try {
      await httpTauri.savePreferences({ ...prefs, vimMode: !prefs.vimMode });
      await queryClient.invalidateQueries({ queryKey: ["preferences"] });
    } catch (err) {
      console.error("[markdown] toggle vim failed", err);
    }
  }, [prefs, queryClient]);

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
                prefs?.vimMode
                  ? "Vim mode is ON — click to disable globally"
                  : "Vim mode is OFF — click to enable globally"
              }
              className={cn(
                "gap-1 font-mono uppercase tracking-wider",
                prefs?.vimMode
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              <Keyboard className="size-3" /> vim{" "}
              {prefs?.vimMode ? "on" : "off"}
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
          <TabStrip />
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
              // The editor stays mounted across tab switches — we
              // pump fresh content through the imperative handle
              // when `activeTabId` changes.  Cursor + undo history
              // reset on switch in v1.
              <MarkdownEditor
                imperativeRef={editorRef}
                value={tab?.doc ?? ""}
                onChange={onChange}
                onSave={onSave}
                vimMode={vimMode}
                getDocDir={getDocDir}
                getCurrentPath={getCurrentPath}
                getVaults={getVaults}
                getWikilinkCandidates={getCandidates}
                onWikilinkOpen={onWikilinkOpen}
                onLinkOpen={onLinkOpen}
                onImageSaved={onImageSaved}
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
