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
 * 1. On mount: `markdownTauri.readFile(path)` for the SVG bytes.
 *    Empty file → fresh empty scene.  Otherwise → `loadFromBlob` to
 *    restore the embedded scene.
 * 2. The `<Excalidraw>` component drives the canvas.  Its
 *    `onChange` callback hands us the live `{ elements, appState,
 *    files }` triplet, which we stash in a ref so the Cmd+S handler
 *    can serialise on demand without forcing React re-renders.
 * 3. First user edit fires `onDirty()` to flip the header dirty dot.
 * 4. Cmd+S calls `exportToSvg({ ..., appState: { ..., exportEmbedScene: true } })`,
 *    serialises the resulting `<svg>` element, and hands it to
 *    `onSave(svg)`.  The store's `saveCurrent(overrideContent)`
 *    writes those bytes to disk and dispatches `markSaved`.
 *
 * The drawing data never lives in `tab.doc` — that string would
 * bounce through the reducer on every reducer pass and cost megabytes
 * of churn.  We treat the Excalidraw canvas as an out-of-band
 * authority and only round-trip the SVG bytes at read/save time.
 */

import {
  Excalidraw,
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
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { markdownTauri } from "../lib/tauri";

interface ExcalidrawEditorProps {
  /** Absolute path of the open `*.excalidraw.svg` file. */
  path: string;
  /** Called on the first user-driven edit so the header can flip the
   *  dirty dot.  Called once per "load → first edit" cycle; the
   *  parent decides what to do with subsequent calls. */
  onDirty: () => void;
  /** Called from the local Cmd+S handler with the freshly serialised
   *  SVG (with embedded scene).  Parent typically routes through
   *  `saveCurrent(svg)` to write to disk + flip dirty back to false. */
  onSave: (svg: string) => void;
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
  theme,
}: ExcalidrawEditorProps) {
  const [initialData, setInitialData] = useState<
    ExcalidrawInitialDataState | null | undefined
  >(undefined); // `undefined` = still loading
  const [loadError, setLoadError] = useState<string | null>(null);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sceneRef = useRef<LiveScene | null>(null);
  const dirtiedRef = useRef(false);

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
        const svg = await markdownTauri.readFile(path);
        if (cancelled) return;

        if (!svg || svg.trim() === "") {
          // Brand-new file (created via "New file" → empty bytes).
          // Pass `null` to let Excalidraw start with an empty scene.
          setInitialData(null);
          return;
        }

        const blob = new Blob([svg], { type: "image/svg+xml" });
        const restored = await loadFromBlob(blob, null, null);
        if (cancelled) return;
        setInitialData({
          elements: restored.elements,
          appState: restored.appState,
          files: restored.files,
        });
      } catch (err) {
        if (cancelled) return;
        // Most common failure: file isn't an Excalidraw-flavoured SVG
        // (no embedded scene).  Fall back to an empty scene so the
        // user can still draw — saving overwrites the broken file.
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
        const svgEl = await exportToSvg({
          elements: scene.elements,
          // Tell Excalidraw to embed the scene JSON inside the SVG so
          // the file round-trips through `loadFromBlob`.  This flag
          // lives on `appState`, not the top-level export options.
          appState: { ...scene.appState, exportEmbedScene: true },
          files: scene.files,
        });
        const svg = new XMLSerializer().serializeToString(svgEl);
        onSave(svg);
      } catch (err) {
        console.error("[excalidraw] exportToSvg failed", err);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onSave]);

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
          sceneRef.current = { elements, appState, files };
          if (!dirtiedRef.current) {
            dirtiedRef.current = true;
            onDirty();
          }
        }}
      />
    </div>
  );
}
