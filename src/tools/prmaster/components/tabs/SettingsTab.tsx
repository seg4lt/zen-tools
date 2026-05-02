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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
        <div className="flex flex-col gap-3 p-3">
          {error && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="p-3 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          )}

          {status && <StatusStrip status={status} />}

          {loadingSettings || !settings ? (
            <Card>
              <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading settings…
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
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
                    <Input
                      id="ai-model"
                      value={settings.ai_model}
                      onChange={(e) =>
                        void persist({
                          ...settings,
                          ai_model: e.target.value,
                        })
                      }
                      placeholder="sonnet"
                      className="h-8 w-44 font-mono"
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
                      max={8}
                      value={settings.ai_token_ratio}
                      onChange={(e) =>
                        void persist({
                          ...settings,
                          ai_token_ratio: Math.min(
                            8,
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
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <Icon className={cn("size-4 shrink-0", tone)} />
        <div className="flex-1 text-sm font-medium">{headline}</div>
        {status.version && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Terminal className="size-3" />
            {status.version}
          </span>
        )}
      </CardContent>
    </Card>
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
    <Card className={cn(wide && "lg:col-span-2")}>
      <CardHeader className="border-b px-4 py-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 p-3">{children}</CardContent>
    </Card>
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
    <div className="flex items-center justify-between gap-3 py-1">
      <Label htmlFor={id} className="text-sm font-normal">
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
    <div className="flex items-center justify-between gap-3 py-1">
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
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
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        Each row contributes <code className="font-mono">prefix + N + suffix</code>{" "}
        to the menu-bar text when its count is non-zero. Prefix/suffix accept
        emoji ({" "}
        <span className="font-mono">"👀 "</span>,{" "}
        <span className="font-mono">"✅ "</span>,{" "}
        <span className="font-mono">"🚀 "</span> ). Pick{" "}
        <em>Saved filter</em> to badge against a stored filter from the
        Filters tab.
      </p>

      {configs.length === 0 && (
        <span className="text-xs italic text-muted-foreground">
          No badge sources — the menu-bar icon will display no count.
        </span>
      )}
      {configs.map((cfg, idx) => (
        <div
          key={idx}
          className="grid gap-2 rounded-md border bg-background p-2"
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
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Map GitHub repositories to local clones for faster AI Summary
        generation (5-10× speedup). The list caches for 7 days — use{" "}
        <strong>Fetch</strong> to refresh from GitHub on demand.
      </p>

      {/* Add mapping row: [searchable repo dropdown] [Browse for folder…] */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2">
        <SearchableRepoDropdown
          items={unmappedRepos}
          value={pickRepo}
          onChange={setPickRepo}
          loading={reposLoading}
          fetching={reposFetching}
          onReload={() => void reloadRepos()}
          onFetch={() => void fetchRepos()}
          footer={cacheFooter}
          placeholder={
            unmappedRepos.length === 0
              ? availableRepos.length === 0
                ? "No repositories cached — click Fetch"
                : "All repositories are mapped"
              : "Pick a repository to map…"
          }
          disabled={availableRepos.length === 0 && !reposFetching}
        />
        <Button
          size="sm"
          variant="default"
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
        <div className="grid gap-1.5">
          {mappings.map((m, idx) => (
            <div
              key={`${m.repo}-${idx}`}
              className="grid grid-cols-[14rem_1fr_auto_auto] items-center gap-2 rounded-md border bg-background p-2"
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
