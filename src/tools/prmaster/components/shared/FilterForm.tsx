/**
 * Inline filter editor used by FiltersTab. Mirrors PRMaster's
 * `FilterPopover` / `FiltersView` form: name, comma-separated
 * authors / repos / file globs, optional title regex, action selector,
 * enabled toggle. Saves through `prmaster_save_filter`.
 */

import { useEffect, useState } from "react";
import { Loader2, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  prmasterTauri,
  type NotificationActionKind,
  type NotificationFilter,
} from "../../lib/tauri";

interface Props {
  initial: NotificationFilter;
  onCancel: () => void;
  onSaved: (filter: NotificationFilter) => void;
}

export function FilterForm({ initial, onCancel, onSaved }: Props) {
  const [name, setName] = useState(initial.name);
  const [authors, setAuthors] = useState(initial.authors.join(", "));
  const [repos, setRepos] = useState(initial.repos.join(", "));
  const [globs, setGlobs] = useState(initial.file_globs.join(", "));
  const [titleRegex, setTitleRegex] = useState(initial.title_regex ?? "");
  const [action, setAction] = useState<NotificationActionKind>(initial.action);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial.name);
    setAuthors(initial.authors.join(", "));
    setRepos(initial.repos.join(", "));
    setGlobs(initial.file_globs.join(", "));
    setTitleRegex(initial.title_regex ?? "");
    setAction(initial.action);
    setEnabled(initial.enabled);
  }, [initial]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const next: NotificationFilter = {
        ...initial,
        name: name.trim() || "Untitled",
        authors: csv(authors),
        repos: csv(repos),
        file_globs: csv(globs),
        title_regex: titleRegex.trim() === "" ? null : titleRegex.trim(),
        action,
        enabled,
        updated_at_ms: Date.now(),
      };
      await prmasterTauri.saveFilter(next);
      onSaved(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-4 p-4">
        <Field id="filter-name" label="Name">
          <Input
            id="filter-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Hot path PRs"
          />
        </Field>

        <Field
          id="filter-authors"
          label="Authors"
          hint="GitHub logins, comma-separated. Empty = any."
        >
          <Input
            id="filter-authors"
            value={authors}
            onChange={(e) => setAuthors(e.target.value)}
            placeholder="alice, bob"
            className="font-mono"
          />
        </Field>

        <Field
          id="filter-repos"
          label="Repos"
          hint='Full ("owner/repo") or short ("repo") names. Empty = any.'
        >
          <Input
            id="filter-repos"
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
            placeholder="org/api, frontend"
            className="font-mono"
          />
        </Field>

        <Field
          id="filter-globs"
          label="File globs"
          hint='e.g. "src/**/*.rs". Empty = any file.'
        >
          <Input
            id="filter-globs"
            value={globs}
            onChange={(e) => setGlobs(e.target.value)}
            placeholder="src/**/*.rs, db/migrations/**"
            className="font-mono"
          />
        </Field>

        <Field
          id="filter-title"
          label="Title regex"
          hint="Case-insensitive match against the PR title."
        >
          <Input
            id="filter-title"
            value={titleRegex}
            onChange={(e) => setTitleRegex(e.target.value)}
            placeholder="^breaking|^!"
            className="font-mono"
          />
        </Field>

        <Separator />

        <Field id="filter-action" label="Action">
          <Select
            value={action}
            onValueChange={(v) => setAction(v as NotificationActionKind)}
          >
            <SelectTrigger id="filter-action" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sound_banner">Sound + Banner</SelectItem>
              <SelectItem value="silent_banner">Silent Banner</SelectItem>
              <SelectItem value="badge_only">Badge Only</SelectItem>
              <SelectItem value="mute">Mute</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Label className="cursor-pointer">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
          />
          <span>Enabled</span>
        </Label>

        {error && (
          <Textarea
            readOnly
            value={error}
            className="border-destructive/40 bg-destructive/10 text-xs text-destructive"
            rows={2}
          />
        )}
      </CardContent>
      <CardFooter className="gap-2 border-t px-4 py-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          <X className="size-4" />
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      {id ? (
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
      ) : (
        <span className="text-xs font-medium">{label}</span>
      )}
      {children}
      {hint && (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

function csv(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
