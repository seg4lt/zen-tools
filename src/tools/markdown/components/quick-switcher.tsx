/**
 * Cmd+O quick switcher.
 *
 * Fuzzy-ish file finder over every `.md` in every open vault.  Two
 * groups: "Recent" (from the persisted ring) and "All files".  Enter
 * dispatches `openFile`; the dialog closes itself.
 */

import { useMemo } from "react";
import { Clock, FileText } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useMarkdownStore } from "../store/markdown-store";
import { useOpenFile } from "../hooks/use-open-file";
import { basenameNoExt } from "../lib/tauri";

export function QuickSwitcher() {
  const { state, dispatch } = useMarkdownStore();
  const { openFile } = useOpenFile();

  // Flat list of every file across vaults — tagged with vault basename
  // so two notes with the same name can be told apart.
  const allFiles = useMemo(() => {
    const out: { path: string; name: string; vaultName: string }[] = [];
    for (const vault of Object.values(state.files)) {
      for (const item of vault.items) {
        if (item.isDir) continue;
        out.push({
          path: item.path,
          name: item.name,
          vaultName: vault.name,
        });
      }
    }
    return out;
  }, [state.files]);

  // Recents: hydrate to `{path, name, vaultName}` rows that still
  // exist on disk (or at least in our current vault scan).
  const recents = useMemo(() => {
    const byPath = new Map(allFiles.map((f) => [f.path, f]));
    return state.recents
      .map((p) => byPath.get(p))
      .filter((x): x is (typeof allFiles)[number] => Boolean(x));
  }, [allFiles, state.recents]);

  const close = () => dispatch({ type: "setQuickSwitcher", open: false });

  const onPick = (path: string) => {
    void openFile(path);
    close();
  };

  return (
    <CommandDialog
      open={state.quickSwitcherOpen}
      onOpenChange={(open) =>
        dispatch({ type: "setQuickSwitcher", open })
      }
      title="Quick switcher"
      description="Open a markdown file by name."
    >
      <CommandInput placeholder="Type to search files…" />
      <CommandList>
        <CommandEmpty>No files match.</CommandEmpty>
        {recents.length > 0 ? (
          <>
            <CommandGroup heading="Recent">
              {recents.slice(0, 8).map((f) => (
                <CommandItem
                  key={`recent:${f.path}`}
                  value={`${basenameNoExt(f.path)} ${f.path}`}
                  onSelect={() => onPick(f.path)}
                >
                  <Clock />
                  <span>{basenameNoExt(f.path)}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60">
                    {f.vaultName}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
        <CommandGroup heading="All files">
          {allFiles.map((f) => (
            <CommandItem
              key={f.path}
              value={`${basenameNoExt(f.path)} ${f.path}`}
              onSelect={() => onPick(f.path)}
            >
              <FileText />
              <span>{basenameNoExt(f.path)}</span>
              <span className="ml-auto text-[10px] text-muted-foreground/60">
                {f.vaultName}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
