/**
 * Settings tab — dense, two-column grid built on shadcn primitives.
 *
 * Layout:
 *   - Slim header (matches every other PRMaster tab)
 *   - Top-of-content GitHub CLI status banner (full width, compact)
 *   - 2-column responsive grid of sections (Refresh / Notifications /
 *     Menu-bar badge / AI provider / Local repo mappings) — wide
 *     editors (badge / mappings) span both columns.
 *   - Footer with Quit button.
 *
 * Saving any field writes the whole `PrMasterSettings` blob via
 * `prmaster_save_settings` (atomic per-key on the `UserConfig` SQLite
 * store).
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldQuestion,
  Terminal,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Badge } from "@zen-tools/ui";
import { Button } from "@zen-tools/ui";
import { Input } from "@zen-tools/ui";
import { Label } from "@zen-tools/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zen-tools/ui";
import { Switch } from "@zen-tools/ui";
import { cn } from "@zen-tools/ui";
import {
  prmasterTauri,
  type BadgeSourceConfig,
  type BadgeSourceKind,
  type GhStatus,
  type LocalRepoMapping,
  type NotificationFilter,
  type PrMasterSettings,
} from "../../lib/tauri";
import { SearchableRepoDropdown } from "../shared/SearchableRepoDropdown";
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "../shared/density";

export function SettingsTab() {
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<PrMasterSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function refreshStatus() {
    setLoadingStatus(true);
    try {
      setStatus(await prmasterTauri.ghStatus());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    void (async () => {
      try {
        setSettings(await prmasterTauri.getSettings());
      } catch (err) {
        setError(formatError(err));
      } finally {
        setLoadingSettings(false);
      }
    })();
  }, []);

  async function persist(next: PrMasterSettings) {
    setSettings(next);
    try {
      await prmasterTauri.saveSettings(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(formatError(err));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Settings</h2>
          <span className="text-xs text-muted-foreground">
            Auth via <code className="font-mono">gh auth login</code>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {savedAt && (
            <span className="text-xs text-muted-foreground">
              Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={loadingStatus}
            onClick={() => void refreshStatus()}
          >
            {loadingStatus ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Recheck
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void prmasterTauri.quit()}
          >
            <Power className="size-4" />
            Quit
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        <div className="flex flex-col gap-2 p-2">
          {error && (
            <Panel className="border-destructive/40 bg-destructive/5">
              <PanelContent className="p-2 text-xs text-destructive">
                {error}
              </PanelContent>
            </Panel>
          )}

          {status && <StatusStrip status={status} />}

          {loadingSettings || !settings ? (
            <Panel>
              <PanelContent className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading settings…
              </PanelContent>
            </Panel>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              <Section title="Refresh">
                <SwitchRow
                  id="enabled"
                  label="Background polling"
                  checked={settings.enabled}
                  onChange={(v) => void persist({ ...settings, enabled: v })}
                />
                <FieldRow
                  id="poll"
                  label="Interval"
                  control={
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="poll"
                        type="number"
                        min={30}
                        step={30}
                        value={settings.polling_interval_secs}
                        onChange={(e) =>
                          void persist({
                            ...settings,
                            polling_interval_secs: Math.max(
                              30,
                              Number(e.target.value),
                            ),
                          })
                        }
                        className="h-8 w-24"
                      />
                      <span className="text-xs text-muted-foreground">
                        sec
                      </span>
                    </div>
                  }
                />
                <SwitchRow
                  id="hotkey"
                  label="Global hotkey (⌥⌘⇧P)"
                  checked={settings.global_shortcut_enabled}
                  onChange={(v) =>
                    void persist({
                      ...settings,
                      global_shortcut_enabled: v,
                    })
                  }
                />
                <SwitchRow
                  id="launch"
                  label="Launch at login"
                  checked={settings.launch_at_login}
                  onChange={(v) =>
                    void persist({ ...settings, launch_at_login: v })
                  }
                />
              </Section>

              <Section title="Notifications">
                <SwitchRow
                  id="notif"
                  label="Enabled"
                  checked={settings.notifications_enabled}
                  onChange={(v) =>
                    void persist({ ...settings, notifications_enabled: v })
                  }
                />
                <SwitchRow
                  id="onlyfilter"
                  label="Only filtered PRs"
                  checked={settings.only_filter_notifications}
                  onChange={(v) =>
                    void persist({
                      ...settings,
                      only_filter_notifications: v,
                    })
                  }
                />
                <SwitchRow
                  id="mypr"
                  label="Activity on my PRs"
                  checked={settings.my_pr_notifications_enabled}
                  onChange={(v) =>
                    void persist({
                      ...settings,
                      my_pr_notifications_enabled: v,
                    })
                  }
                />
              </Section>

              <Section title="AI provider">
                <FieldRow
                  id="ai-prov"
                  label="Provider"
                  control={
                    <Select
                      value={settings.ai_provider}
                      onValueChange={(v) =>
                        void persist({ ...settings, ai_provider: v })
                      }
                    >
                      <SelectTrigger
                        id="ai-prov"
                        size="sm"
                        className="h-8 w-44"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">Claude</SelectItem>
                        <SelectItem value="copilot">Copilot</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />
                <FieldRow
                  id="ai-model"
                  label="Model"
                  control={
                    <ModelSelect
                      provider={settings.ai_provider}
                      value={settings.ai_model}
                      onChange={(v) =>
                        void persist({ ...settings, ai_model: v })
                      }
                    />
                  }
                />
                <FieldRow
                  id="token-ratio"
                  label="Token ratio"
                  control={
                    <Input
                      id="token-ratio"
                      type="number"
                      min={1}
                      max={4}
                      value={settings.ai_token_ratio}
                      onChange={(e) =>
                        void persist({
                          ...settings,
                          // Clamped 1–4 to match the Swift Copilot
                          // stepper (`AIProviderSection.swift:145`).
                          ai_token_ratio: Math.min(
                            4,
                            Math.max(1, Number(e.target.value)),
                          ),
                        })
                      }
                      className="h-8 w-20"
                    />
                  }
                />
              </Section>

              <Section title="Menu-bar badge">
                <BadgeEditor
                  configs={settings.badge_configs}
                  onChange={(badge_configs) =>
                    void persist({ ...settings, badge_configs })
                  }
                />
              </Section>

              <Section title="Local repo mappings" wide>
                <RepoMappingsEditor
                  mappings={settings.repo_mappings}
                  onChange={(repo_mappings) =>
                    void persist({ ...settings, repo_mappings })
                  }
                />
              </Section>

              <Section title="Additional commit authors" wide>
                <ExtraAuthorsEditor
                  authors={settings.extra_authors}
                  onChange={(extra_authors) =>
                    void persist({ ...settings, extra_authors })
                  }
                />
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusStrip({ status }: { status: GhStatus }) {
  const ok = status.installed && status.authenticated;
  const Icon = ok
    ? CheckCircle2
    : status.installed
      ? ShieldAlert
      : ShieldQuestion;
  const tone = ok
    ? "text-emerald-600 dark:text-emerald-400"
    : status.installed
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
  const headline = !status.installed
    ? "gh is not installed"
    : !status.authenticated
      ? "gh is not authenticated"
      : `Logged in${status.login ? ` as @${status.login}` : ""}${status.host ? ` on ${status.host}` : ""}`;
  return (
    <Panel>
      <PanelContent className="flex items-center gap-2 px-3 py-1.5">
        <Icon className={cn("size-3.5 shrink-0", tone)} />
        <div className="flex-1 text-xs font-medium">{headline}</div>
        {status.version && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Terminal className="size-3" />
            {status.version}
          </span>
        )}
      </PanelContent>
    </Panel>
  );
}

function Section({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Panel className={cn(wide && "lg:col-span-2")}>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelContent className="grid gap-1.5 p-2">{children}</PanelContent>
    </Panel>
  );
}

function FieldRow({
  id,
  label,
  control,
}: {
  id?: string;
  label: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="cursor-pointer text-xs font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function BadgeEditor({
  configs,
  onChange,
}: {
  configs: BadgeSourceConfig[];
  onChange: (next: BadgeSourceConfig[]) => void;
}) {
  const [savedFilters, setSavedFilters] = useState<NotificationFilter[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await prmasterTauri.listFilters();
        if (alive) setSavedFilters(list);
      } catch {
        // Filters tab surfaces failures on its own; the badge editor
        // simply hides the saved-filter picker when nothing loads.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function update(idx: number, patch: Partial<BadgeSourceConfig>) {
    onChange(configs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function remove(idx: number) {
    onChange(configs.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...configs,
      { source: "to_review", prefix: "", suffix: "", enabled: true },
    ]);
  }
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted-foreground">
        Each enabled row contributes{" "}
        <code className="font-mono">prefix + N + suffix</code> to the
        menu-bar (emoji ok: <span className="font-mono">"👀 "</span>,{" "}
        <span className="font-mono">"✅ "</span>).
      </p>

      {configs.length === 0 && (
        <span className="text-xs italic text-muted-foreground">
          No badge sources — the menu-bar icon will show no count.
        </span>
      )}
      {configs.map((cfg, idx) => (
        <div
          key={idx}
          className="grid gap-1.5 rounded-md border bg-background p-1.5"
        >
          {/* Row 1 — source + prefix/suffix preview + remove */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-2">
            <Switch
              checked={cfg.enabled}
              onCheckedChange={(v) => update(idx, { enabled: v })}
            />
            <Select
              value={cfg.source}
              onValueChange={(v) => {
                const source = v as BadgeSourceKind;
                update(idx, {
                  source,
                  // Reset filter_id when leaving the filter source.
                  filter_id: source === "filter" ? cfg.filter_id ?? null : null,
                });
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="to_review">To Review</SelectItem>
                <SelectItem value="reviewed">Done</SelectItem>
                <SelectItem value="my_prs">My PRs</SelectItem>
                <SelectItem value="filter">Saved filter</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={cfg.prefix}
              onChange={(e) => update(idx, { prefix: e.target.value })}
              placeholder="prefix"
              className="h-8 w-20 font-mono"
              title="Prefix (supports emoji)"
            />
            <Badge variant="outline" className="font-mono">
              {cfg.prefix}N{cfg.suffix}
            </Badge>
            <Input
              value={cfg.suffix}
              onChange={(e) => update(idx, { suffix: e.target.value })}
              placeholder="suffix"
              className="h-8 w-20 font-mono"
              title="Suffix (supports emoji)"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => remove(idx)}
              aria-label="Remove badge source"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>

          {/* Row 2 — saved-filter dropdown only when source = filter */}
          {cfg.source === "filter" && (
            <div className="ml-10 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filter</span>
              <Select
                value={cfg.filter_id ?? undefined}
                onValueChange={(v) => update(idx, { filter_id: v })}
              >
                <SelectTrigger size="sm" className="h-8 flex-1">
                  <SelectValue
                    placeholder={
                      savedFilters.length === 0
                        ? "No saved filters — add one in Filters tab"
                        : "Pick a saved filter…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {savedFilters.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {cfg.filter_id &&
                !savedFilters.some((f) => f.id === cfg.filter_id) && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    filter no longer exists
                  </span>
                )}
            </div>
          )}
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={add} className="w-fit">
        <Plus className="size-3.5" />
        Add source
      </Button>
    </div>
  );
}

function RepoMappingsEditor({
  mappings,
  onChange,
}: {
  mappings: LocalRepoMapping[];
  onChange: (next: LocalRepoMapping[]) => void;
}) {
  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposFetching, setReposFetching] = useState(false);
  const [reposCachedAt, setReposCachedAt] = useState<number | null>(null);
  const [reposStale, setReposStale] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [pickRepo, setPickRepo] = useState<string | null>(null);

  async function reloadRepos() {
    setReposLoading(true);
    setReposError(null);
    try {
      const result = await prmasterTauri.listAccessibleRepos();
      setAvailableRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
      setReposStale(result.stale);
    } catch (err) {
      setReposError(formatError(err));
    } finally {
      setReposLoading(false);
    }
  }

  async function fetchRepos() {
    setReposFetching(true);
    setReposError(null);
    try {
      const result = await prmasterTauri.fetchRepos();
      setAvailableRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
      setReposStale(result.stale);
    } catch (err) {
      setReposError(formatError(err));
    } finally {
      setReposFetching(false);
    }
  }

  useEffect(() => {
    void reloadRepos();
  }, []);

  const mappedSet = new Set(mappings.map((m) => m.repo));
  const unmappedRepos = availableRepos.filter((r) => !mappedSet.has(r));

  async function addMappingForSelected() {
    if (!pickRepo) return;
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: `Select local git folder for ${pickRepo}`,
    });
    if (typeof result === "string") {
      onChange([...mappings, { repo: pickRepo, local_path: result }]);
      setPickRepo(null);
    }
  }

  async function rePickDir(idx: number) {
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: `Select local git folder for ${mappings[idx]?.repo ?? "repo"}`,
    });
    if (typeof result === "string") {
      onChange(
        mappings.map((m, i) =>
          i === idx ? { ...m, local_path: result } : m,
        ),
      );
    }
  }

  function remove(idx: number) {
    onChange(mappings.filter((_, i) => i !== idx));
  }

  const cacheFooter =
    reposCachedAt == null
      ? `${availableRepos.length} repositories cached`
      : `${availableRepos.length} cached · ${formatCacheAge(reposCachedAt)}${reposStale ? " (stale, click Fetch)" : ""}`;

  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted-foreground">
        Map GitHub repos → local clones for faster AI Summary (5–10×).
        Cache TTL 7d.
      </p>

      {/* Cache strip — always-visible Fetch + cache age. The cache is
          loaded automatically on mount and shared with the AI tab, so
          there's no separate "Reload from local cache" button — the
          only meaningful action is fetching fresh data from GitHub. */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {cacheFooter}
          {(reposStale || availableRepos.length === 0) && (
            <span className="text-amber-600 dark:text-amber-400">●</span>
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={reposFetching}
          onClick={() => void fetchRepos()}
          title="Re-fetch the full repo list from GitHub (ignores cache)"
        >
          {reposFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          Fetch
        </Button>
      </div>

      {/* Add mapping row: [searchable repo dropdown] [Browse for folder…] */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-1.5">
        <SearchableRepoDropdown
          items={unmappedRepos}
          value={pickRepo}
          onChange={setPickRepo}
          loading={reposLoading}
          fetching={reposFetching}
          onFetch={() => void fetchRepos()}
          footer={cacheFooter}
          placeholder={
            unmappedRepos.length === 0
              ? availableRepos.length === 0
                ? "No repositories cached — click Fetch from GitHub"
                : "All repositories are mapped"
              : "Pick a repository to map…"
          }
          disabled={availableRepos.length === 0 && !reposFetching}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!pickRepo}
          onClick={() => void addMappingForSelected()}
        >
          <Plus className="size-3.5" />
          Browse for folder…
        </Button>
      </div>

      {reposError && (
        <span className="text-xs text-destructive">{reposError}</span>
      )}

      {/* Existing mappings list */}
      {mappings.length === 0 ? (
        <span className="text-xs italic text-muted-foreground">
          No mappings yet — AI Summary will fall back to{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">
            gh api repos/&#123;owner/repo&#125;/commits
          </code>
          .
        </span>
      ) : (
        <div className="grid gap-1">
          {mappings.map((m, idx) => (
            <div
              key={`${m.repo}-${idx}`}
              className="grid grid-cols-[14rem_1fr_auto_auto] items-center gap-2 rounded-md border bg-background px-2 py-1"
            >
              <span className="truncate font-mono text-xs">{m.repo}</span>
              <span
                className="truncate font-mono text-xs text-muted-foreground"
                title={m.local_path}
              >
                {tildify(m.local_path)}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void rePickDir(idx)}
              >
                Change…
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => remove(idx)}
                aria-label="Remove mapping"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Editor for the "additional commit authors" list. Backs
 *  `PrMasterSettings.extra_authors` — each entry becomes a separate
 *  `git log --author=<value>` flag during AI summary generation, so
 *  the search widens beyond the user's current local git identity
 *  to cover renames / past emails / teammates. The text input takes
 *  comma-separated values; we split, trim, and de-dupe on every
 *  change. Existing entries also render as removable chips so users
 *  can edit one at a time without retyping the whole list. */
function ExtraAuthorsEditor({
  authors,
  onChange,
}: {
  authors: string[];
  onChange: (next: string[]) => void;
}) {
  // Local draft so the user can type freely (commas mid-word, partial
  // emails, etc.) without each keystroke reformatting the field.
  // We push the parsed list upward on blur or Enter.
  const [draft, setDraft] = useState("");

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parsed.length === 0) {
      setDraft("");
      return;
    }
    const merged = mergeAuthors(authors, parsed);
    if (merged.length !== authors.length) onChange(merged);
    setDraft("");
  }

  function removeAt(i: number) {
    onChange(authors.filter((_, idx) => idx !== i));
  }

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Combined (OR) with the local git identity of each mapped repo
        when fetching commits for an AI summary. Plain logins (
        <code className="font-mono">alice</code>), full emails (
        <code className="font-mono">alice@github.com</code>), or
        display names all work — git matches them as substrings.
      </p>

      {authors.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {authors.map((a, i) => (
            <Badge
              key={`${a}-${i}`}
              variant="secondary"
              className="gap-1 pr-1 font-mono text-[11px]"
            >
              <span>{a}</span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="cursor-pointer rounded-full p-0.5 hover:bg-muted-foreground/20"
                aria-label={`Remove ${a}`}
              >
                <Trash2 className="size-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="alice@example.com, bob, charlie@old-job.com"
        className="h-8 font-mono"
      />
    </div>
  );
}

/** Merge two author lists case-insensitively, preserving the order of
 *  the original list and appending only genuinely new entries. */
function mergeAuthors(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((a) => a.toLowerCase()));
  const out = existing.slice();
  for (const a of incoming) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Select for the active provider's models. Mirrors the Swift
 *  `AIProviderSection.swift:104–141` model picker — populated from
 *  `prmaster_ai_list_models` on mount and whenever the provider
 *  changes. Falls back to a free-text Input when the provider isn't
 *  installed / the list call fails, so the user can still edit the
 *  stored model string. */
function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
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
        setModels(list);
      } catch {
        if (!alive) return;
        setFailed(true);
        setModels([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider]);

  // If the list-call failed (provider missing) or the persisted value
  // isn't in the returned list, fall through to a free-text editor.
  if (failed || (models.length > 0 && !models.includes(value))) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          id="ai-model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sonnet"
          className="h-8 w-44 font-mono"
        />
        {failed && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            list unavailable
          </span>
        )}
      </div>
    );
  }

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id="ai-model" size="sm" className="h-8 w-44 font-mono">
        <SelectValue
          placeholder={
            loading ? "Loading models…" : models.length === 0 ? "—" : "Pick…"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m} value={m} className="font-mono">
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function tildify(path: string): string {
  // Best-effort home-dir collapse — works for the common macOS layout.
  // The exact $HOME is not available to the renderer, so we match the
  // first two leading segments of `/Users/<name>/`.
  const m = /^(\/Users\/[^/]+)(\/.*)?$/.exec(path);
  if (m) return "~" + (m[2] ?? "");
  return path;
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function formatCacheAge(cachedAtMs: number): string {
  const ageMs = Date.now() - cachedAtMs;
  if (ageMs < 60_000) return "fetched just now";
  const mins = Math.round(ageMs / 60_000);
  if (mins < 60) return `fetched ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `fetched ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `fetched ${days}d ago`;
}
