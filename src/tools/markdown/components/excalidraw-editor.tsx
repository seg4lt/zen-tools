/**
 * Excalidraw drawing pane.
 *
 * Mounted by `MarkdownView` instead of the CodeMirror markdown editor
 * when the active tab's `kind === "excalidraw"`.  This file is the
 * **default export** so it can be loaded via `React.lazy()` — the
 * `@excalidraw/excalidraw` package weighs ~3 MB and we don't want it
 * in the main bundle.
 *
 * Lifecycle:
 * 1. On mount: `fetch(convertFileSrc(path))` for the file's bytes
 *    (works for both `.excalidraw.svg` text and `.excalidraw.png`
 *    binary; `loadFromBlob` inspects the MIME type itself).  Empty
 *    file → fresh empty scene.  Otherwise → `loadFromBlob` to
 *    restore the embedded scene.
 * 2. The `<Excalidraw>` component drives the canvas.  Its
 *    `onChange` callback hands us the live `{ elements, appState,
 *    files }` triplet, which we stash in a ref so the Cmd+S handler
 *    can serialise on demand without forcing React re-renders.
 * 3. First user edit fires `onDirty()` to flip the header dirty dot.
 * 4. Cmd+S calls either `exportToSvg` (for `.excalidraw.svg` paths)
 *    or `exportToBlob({ mimeType: "image/png" })` (for
 *    `.excalidraw.png` paths) with `appState.exportEmbedScene: true`.
 *    The serialised result — a string for SVG or a `Uint8Array` for
 *    PNG — is handed to `onSave(...)`; the store's
 *    `saveCurrent(overrideContent)` routes it to `writeFile` /
 *    `writeBytes` accordingly.
 *
 * The drawing data never lives in `tab.doc` — that string would
 * bounce through the reducer on every reducer pass and cost megabytes
 * of churn.  We treat the Excalidraw canvas as an out-of-band
 * authority and only round-trip the SVG bytes at read/save time.
 */

import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
  loadFromBlob,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface ExcalidrawEditorProps {
  /** Absolute path of the open `*.excalidraw.svg` *or*
   *  `*.excalidraw.png` file.  The trailing extension chooses which
   *  exporter the Cmd+S handler uses (SVG → text, PNG → binary). */
  path: string;
  /** Called on the first user-driven edit so the header can flip the
   *  dirty dot.  Called once per "load → first edit" cycle; the
   *  parent decides what to do with subsequent calls. */
  onDirty: () => void;
  /** Called from the local Cmd+S handler with the freshly serialised
   *  scene.  The host's `saveCurrent(...)` routes a `string` through
   *  `writeFile` (text, used for the SVG path) and a `Uint8Array`
   *  through `writeBytes` (binary, used for the PNG path). */
  onSave: (data: string | Uint8Array) => void;
  /** Called 500 ms after the last user edit with the serialized scene. */
  onAutoSave: (data: string | Uint8Array) => void;
  /** `"dark"` or `"light"` — passed straight through to Excalidraw. */
  theme: "light" | "dark";
}

/** Shape of the live drawing state — kept in a ref, not in React. */
interface LiveScene {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}

export default function ExcalidrawEditor({
  path,
  onDirty,
  onSave,
  onAutoSave,
  theme,
}: ExcalidrawEditorProps) {
  const [initialData, setInitialData] = useState<
    ExcalidrawInitialDataState | null | undefined
  >(undefined); // `undefined` = still loading
  const [loadError, setLoadError] = useState<string | null>(null);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sceneRef = useRef<LiveScene | null>(null);
  const dirtiedRef = useRef(false);
  const readyRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAutoSaveRef = useRef(onAutoSave);

  useEffect(() => {
    onAutoSaveRef.current = onAutoSave;
  }, [onAutoSave]);

  const serializeScene = useCallback(
    async (scene: LiveScene): Promise<string | Uint8Array> => {
      const isPng = path.toLowerCase().endsWith(".excalidraw.png");
      const exportAppState = {
        ...scene.appState,
        exportEmbedScene: true,
      };
      if (isPng) {
        const blob = await exportToBlob({
          elements: scene.elements,
          appState: exportAppState,
          files: scene.files,
          mimeType: "image/png",
        });
        return new Uint8Array(await blob.arrayBuffer());
      }
      const svgEl = await exportToSvg({
        elements: scene.elements,
        appState: exportAppState,
        files: scene.files,
      });
      return new XMLSerializer().serializeToString(svgEl);
    },
    [path],
  );

  // Excalidraw fires onChange while restoring initialData. Give that
  // mount-time callback a frame to settle so opening a drawing never
  // counts as an edit or schedules an overwrite.
  useEffect(() => {
    readyRef.current = false;
    if (initialData === undefined) return;
    const frame = requestAnimationFrame(() => {
      readyRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialData, path]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, []);

  // ────────────────────────────────────────────────────────────────
  // Load the file's bytes off disk and turn them into an Excalidraw
  // initial-data object.  Re-runs only when `path` changes — the
  // caller remounts on a tab switch already, but this guard keeps
  // the read out of every render.
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    dirtiedRef.current = false;
    setLoadError(null);

    async function load() {
      try {
        // Fetch via the asset protocol — works for both `.excalidraw.svg`
        // and `.excalidraw.png` without a separate text/bytes
        // round-trip.  An empty file (newly-created via "New file")
        // comes back with `blob.size === 0` and we start with a
        // fresh empty scene.
        const res = await fetch(convertFileSrc(path));
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`fetch ${path}: HTTP ${res.status}`);
        }
        const blob = await res.blob();
        if (cancelled) return;

        if (blob.size === 0) {
          setInitialData(null);
          return;
        }

        const restored = await loadFromBlob(blob, null, null);
        if (cancelled) return;
        setInitialData({
          elements: restored.elements,
          appState: restored.appState,
          files: restored.files,
        });
      } catch (err) {
        if (cancelled) return;
        // Most common failure: file isn't an Excalidraw-flavoured
        // file (no embedded scene).  Fall back to an empty scene so
        // the user can still draw — saving overwrites the broken
        // file.
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[excalidraw] loadFromBlob failed", path, err);
        setLoadError(message);
        setInitialData(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // ────────────────────────────────────────────────────────────────
  // Cmd+S / Ctrl+S handler.  We deliberately bind on `window` in the
  // capture phase: Excalidraw's own keymap also reacts to Cmd+S
  // (showing its export dialog), and capture-phase + preventDefault
  // wins the race.  Bound only while this editor is mounted.
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const isSave =
        (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s";
      if (!isSave) return;
      const scene = sceneRef.current;
      if (!scene) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        onSave(await serializeScene(scene));
      } catch (err) {
        console.error("[excalidraw] export failed", err);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onSave, path, serializeScene]);

  // ────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────
  if (initialData === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> loading drawing…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" data-tauri-drag-region={false}>
      {loadError ? (
        <div className="absolute left-2 top-2 z-10 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10px] text-destructive">
          load: {loadError}
        </div>
      ) : null}
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        theme={theme}
        onChange={(elements, appState, files) => {
          const scene = { elements, appState, files };
          sceneRef.current = scene;
          if (!readyRef.current) return;
          if (!dirtiedRef.current) {
            dirtiedRef.current = true;
            onDirty();
          }
          if (autoSaveTimerRef.current !== null) {
            clearTimeout(autoSaveTimerRef.current);
          }
          autoSaveTimerRef.current = setTimeout(() => {
            autoSaveTimerRef.current = null;
            const latest = sceneRef.current;
            if (!latest) return;
            void serializeScene(latest)
              .then((data) => onAutoSaveRef.current(data))
              .catch((err) =>
                console.error("[excalidraw] auto-save failed", err),
              );
          }, 500);
        }}
      />
    </div>
  );
}
