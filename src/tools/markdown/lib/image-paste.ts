/**
 * Clipboard-paste-image → write-to-disk → insert-markdown handler.
 *
 * This is the **headline feature** of the markdown tool.  The user
 * copies a screenshot or any other image to the clipboard, places the
 * cursor inside their note, hits Cmd+V, and:
 *
 *   1. We intercept the paste event before CodeMirror's default
 *      handler (which would just dump base64 garbage as text).
 *   2. We pluck the image bytes out of the clipboard.
 *   3. We invoke `markdown_save_pasted_image` to write them next to
 *      the open document — the backend dedupes the file name.
 *   4. We insert `![file-name](returned-relative-path)` at the
 *      current selection.
 *
 * The dispatch is wrapped in `markdownTauri.savePastedImage`; the
 * handler stays purely UI-side.
 */

import { EditorView } from "@codemirror/view";
import { basenameNoExt, dirname, markdownTauri, slugify } from "./tauri";

/** MIME type → file extension we'll write under. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export interface ImagePasteOptions {
  /** Returns the absolute path of the currently-open `.md` file, or
   *  `null` when no file is open (in which case we fall through to
   *  the default paste behaviour). */
  getCurrentPath: () => string | null;
  /** Fired *after* the new image has been written and the editor has
   *  inserted the link. Callers typically use this to re-discover
   *  the vault tree so the freshly-pasted file shows up in the
   *  sidebar without a manual refresh. */
  onImageSaved?: (relPath: string) => void;
}

export function imagePasteHandler(opts: ImagePasteOptions) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items || items.length === 0) return;

      // Find the first item that's actually an image file.
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          imageItem = it;
          break;
        }
      }
      if (!imageItem) return; // not an image paste — let CodeMirror handle it

      const currentPath = opts.getCurrentPath();
      if (!currentPath) {
        // No open file — show a console warning instead of writing
        // somewhere unexpected.  The default paste behaviour follows.
        console.warn(
          "[markdown] image paste ignored — no open file to attach to",
        );
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) return;

      // Take ownership of the event — we'll insert the link ourselves.
      event.preventDefault();

      const ext = MIME_EXT[file.type] ?? "png";
      const stem = slugify(basenameNoExt(currentPath)) || "image";
      const fileName = `${stem}-${Date.now()}.${ext}`;
      const targetDir = dirname(currentPath);

      // Read the bytes off the main thread and ship to the backend.
      // We don't await synchronously inside the paste handler — the
      // event needs to return — so we kick the async work and patch
      // the doc once it lands.
      void (async () => {
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const written = await markdownTauri.savePastedImage(
            targetDir,
            fileName,
            bytes,
          );
          // `written` is `pasted/<file>` — use just the basename for
          // the alt text so the rendered link reads like Obsidian
          // (`![foo-123.png](pasted/foo-123.png)`).
          const altText = written.split("/").pop() ?? written;
          const insert = `![${altText}](${written})`;
          // Insert at the *current* selection — the user may have
          // moved the cursor while the upload was running.
          const pos = view.state.selection.main.head;
          view.dispatch({
            changes: { from: pos, insert },
            selection: { anchor: pos + insert.length },
          });
          // Notify the host so it can rediscover files and surface
          // the newly-created image in the sidebar.
          opts.onImageSaved?.(written);
        } catch (err) {
          console.error("[markdown] image paste failed", err);
        }
      })();
    },
  });
}
