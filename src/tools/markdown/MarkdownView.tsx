/**
 * Two-pane layout: vault sidebar | editor.
 *
 * Reads everything from the store — the editor host gets value-getter
 * callbacks so it doesn't have to remount when the open file changes.
 * `setValue` is fired through the imperative handle whenever the
 * store's `currentFile.path` changes.
 */

import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tauri as httpTauri } from "@/tools/http-runner/lib/tauri";
import { cn } from "@/lib/utils";
import { VaultSidebar } from "./components/vault-sidebar";
import { SearchPalette } from "./components/search-palette";
import { EmptyState } from "./components/empty-state";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "./components/markdown-editor";
import { useMarkdownStore } from "./store/markdown-store";
import { useOpenFile } from "./hooks/use-open-file";
import { useVaults } from "./hooks/use-vaults";
import { useMarkdownKeyboardNav } from "./hooks/use-keyboard-nav";
import { basenameNoExt, dirname } from "./lib/tauri";

export function MarkdownView() {
  // Wire up Cmd+O / Cmd+Shift+O at this level so the listener
  // lifecycles with the view.
  useMarkdownKeyboardNav();

  const { state, dispatch } = useMarkdownStore();
  const { openFile, saveCurrent, resolveWikilink } = useOpenFile();
  const { addVault, refresh: refreshVaults } = useVaults();
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const queryClient = useQueryClient();

  // Re-sync the editor's buffer whenever the current file changes
  // (path or doc).  The editor itself never re-mounts.
  useEffect(() => {
    const handle = editorRef.current;
    if (!handle) return;
    if (state.currentFile) {
      handle.setValue(state.currentFile.doc);
    } else {
      handle.setValue("");
    }
  }, [state.currentFile?.path, state.currentFile?.doc]);

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

  const onSave = useCallback(
    (doc: string) => {
      void saveCurrent(doc);
    },
    [saveCurrent],
  );

  const getDocDir = useCallback(
    () => (state.currentFile ? dirname(state.currentFile.path) : ""),
    [state.currentFile?.path],
  );

  const getCurrentPath = useCallback(
    () => state.currentFile?.path ?? null,
    [state.currentFile?.path],
  );

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
        const dir = state.currentFile ? dirname(state.currentFile.path) : "";
        if (!dir) {
          console.warn(
            "[markdown] relative link with no open document:",
            url,
          );
          return;
        }
        target = `${dir}/${decoded}`;
      }
      // Only markdown gets the editor treatment; other files would
      // render as garbage in CodeMirror.
      const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(target);
      if (!isMarkdown) {
        console.info(
          "[markdown] non-markdown link click ignored (no app handler yet):",
          target,
        );
        return;
      }
      void openFile(target);
    },
    [openFile, state.currentFile?.path],
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
  const hasFile = !!state.currentFile;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
        <span className="text-sm font-medium">Markdown</span>
        {state.currentFile ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px] text-muted-foreground/80",
              state.currentFile.dirty && "text-amber-600 dark:text-amber-300",
            )}
            title={state.currentFile.path}
          >
            {state.currentFile.dirty ? "●" : ""}{" "}
            {basenameNoExt(state.currentFile.path)}.md
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {state.currentFile ? (
            <Button
              size="xs"
              variant="ghost"
              title="Save (Cmd+S / :w)"
              onClick={() => void saveCurrent()}
              className="gap-1"
              disabled={!state.currentFile?.dirty}
            >
              <Save className="size-3" /> Save
            </Button>
          ) : null}
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
            <Keyboard className="size-3" /> vim {prefs?.vimMode ? "on" : "off"}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <VaultSidebar />
        <div className="flex min-h-0 flex-1 flex-col">
          {hasFile ? (
            // The editor stays mounted; we just pump fresh content
            // through the imperative handle when the active file
            // switches.  This keeps undo history per-mount, which is
            // a fair trade-off for a single-tab editor.
            <MarkdownEditor
              imperativeRef={editorRef}
              value={state.currentFile?.doc ?? ""}
              onChange={onChange}
              onSave={onSave}
              vimMode={vimMode}
              getDocDir={getDocDir}
              getCurrentPath={getCurrentPath}
              getWikilinkCandidates={getCandidates}
              onWikilinkOpen={onWikilinkOpen}
              onLinkOpen={onLinkOpen}
              onImageSaved={onImageSaved}
            />
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
