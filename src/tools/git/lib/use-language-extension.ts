/**
 * Hook: pick a CodeMirror language extension based on a filename and
 * lazy-load it via `@codemirror/language-data`.
 *
 *   const { extensions, ready } = useLanguageExtension("foo.ts");
 *
 * Returns:
 *   - `extensions` — `Extension[]` (empty until the language module
 *     finishes loading, then exactly `[langSupport]`).
 *   - `ready`      — `true` once we know what to render. Becomes
 *     `false` only when the file's language is uncached and a
 *     dynamic import is in flight; flips to `true` when it lands.
 *
 * The initial state is computed *synchronously* from the
 * `LanguageDescription` registry — if the language is already cached
 * (it has been used in this session before), the first render is
 * already `{ extensions: [support], ready: true }`. Callers can gate
 * their `<CodeEditor>` mount on `ready` to guarantee the editor
 * mounts with highlighting attached, since the shared editor only
 * reads `extensions` once at mount.
 */

import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export interface LanguageExtension {
  extensions: Extension[];
  ready: boolean;
}

function seed(fileName: string): LanguageExtension {
  if (!fileName) return { extensions: [], ready: true };
  const desc = LanguageDescription.matchFilename(languages, fileName);
  if (!desc) return { extensions: [], ready: true };
  if (desc.support) return { extensions: [desc.support], ready: true };
  return { extensions: [], ready: false };
}

export function useLanguageExtension(fileName: string): LanguageExtension {
  const [state, setState] = useState<LanguageExtension>(() => seed(fileName));

  useEffect(() => {
    const initial = seed(fileName);
    setState(initial);
    if (initial.ready) return;
    // Uncached language — kick off the dynamic import.
    const desc = LanguageDescription.matchFilename(languages, fileName);
    if (!desc) return;
    let cancelled = false;
    desc
      .load()
      .then((support) => {
        if (!cancelled) setState({ extensions: [support], ready: true });
      })
      .catch(() => {
        if (!cancelled) setState({ extensions: [], ready: true });
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  return state;
}
