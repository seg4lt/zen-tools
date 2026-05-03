/**
 * HTTP-aware wrapper around the shared `CodeEditor`.
 *
 * Adds the bits that are specific to `.http` / `.rest` files:
 *  - the custom http language (`httpLanguage`)
 *  - the run gutter (inline play button on each request line)
 *  - `{{var}}` hover tooltip
 *
 * All the generic CM6 plumbing (vim, theme, save, imperative handle)
 * lives in `CodeEditor`.
 */

import { useMemo, type Ref } from "react";
import type { Extension } from "@codemirror/state";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@zen-tools/editor";
import { useTheme } from "@/hooks/use-theme";
import { httpLanguage } from "../lib/lang-http";
import { runGutter } from "../lib/run-gutter";
import { varHoverTooltip, type VarContext } from "../lib/var-hover";
import { useRef, useEffect } from "react";

// Re-export the handle type under the historical name so existing callers
// (`HttpEditorHandle`) keep working.
export type HttpEditorHandle = CodeEditorHandle;

export interface HttpEditorProps {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  onRunLine?: (line: number) => void;
  onRunLineWithDeps?: (line: number) => void;
  /**
   * Editor mode. `"http"` enables the http language + run gutter;
   * `"plain"` is for files like `.perf.yaml` where the gutter is
   * meaningless.
   */
  mode?: "http" | "plain";
  /** Variable context for the `{{var}}` hover tooltip. */
  varContext?: VarContext;
  vimMode?: boolean;
  imperativeRef?: Ref<HttpEditorHandle>;
}

export function HttpEditor({
  value,
  readOnly = false,
  onChange,
  onSave,
  onRunLine,
  onRunLineWithDeps,
  mode = "http",
  varContext,
  vimMode = true,
  imperativeRef,
}: HttpEditorProps) {
  const { theme } = useTheme();
  // The hover tooltip reads the var context from a ref so callers can
  // pass fresh values via a normal prop without rebuilding the editor.
  const varCtxRef = useRef<VarContext>(varContext ?? {});
  useEffect(() => {
    varCtxRef.current = varContext ?? {};
  }, [varContext]);

  // The run-gutter callback also lives behind a ref so it always sees
  // the latest `onRunLine`.
  const onRunLineRef = useRef(onRunLine);
  useEffect(() => {
    onRunLineRef.current = onRunLine;
  }, [onRunLine]);

  const buildExtensions = useMemo(
    () =>
      (_env: { isDark: boolean }): Extension[] => {
        const exts: Extension[] = [];
        if (mode === "http") {
          exts.push(httpLanguage());
          exts.push(runGutter((line) => onRunLineRef.current?.(line)));
        }
        exts.push(varHoverTooltip(varCtxRef));
        return exts;
      },
    [mode],
  );

  return (
    <CodeEditor
      value={value}
      readOnly={readOnly}
      onChange={onChange}
      onSave={onSave}
      onRunLine={onRunLine}
      onRunLineWithDeps={onRunLineWithDeps}
      vimMode={vimMode}
      isDark={theme === "dark"}
      imperativeRef={imperativeRef}
      extensions={buildExtensions}
    />
  );
}
