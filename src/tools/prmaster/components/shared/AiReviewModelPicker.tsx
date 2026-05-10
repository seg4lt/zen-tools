/**
 * Compact model picker for the AI Review tab. Mirrors the
 * `ModelSelect` component used in PR Master Settings, but trimmed to
 * one line so it fits in the tab header. Provider is hardcoded to
 * Claude in v1; if the user has Copilot configured globally we still
 * let them run AI review via Claude (the backend rejects non-Claude
 * starts with a clear error).
 */

import { useEffect, useState } from "react";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zen-tools/ui";
import { prmasterTauri } from "../../lib/tauri";

interface Props {
  value: string;
  onChange: (next: string) => void;
}

/** Stable fallback list when `aiListModels` fails (e.g. claude CLI
 *  unreachable). Matches the static list `ClaudeCliProvider::list_models`
 *  returns today. */
const FALLBACK_MODELS = ["sonnet", "opus", "haiku"];

export function AiReviewModelPicker({ value, onChange }: Props) {
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const list = await prmasterTauri.aiListModels();
        if (!alive) return;
        if (list.length > 0) setModels(list);
      } catch {
        if (!alive) return;
        setFailed(true);
        setModels(FALLBACK_MODELS);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (failed && models.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="sonnet"
        className="h-7 w-32 font-mono text-[11px]"
      />
    );
  }

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 w-32 font-mono text-[11px]">
        <SelectValue
          placeholder={loading ? "Loading…" : "Pick a model"}
        />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m} value={m} className="font-mono text-[11px]">
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
