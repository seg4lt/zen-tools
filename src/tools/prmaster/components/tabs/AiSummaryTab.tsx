/**
 * AI Summary tab — pick a date range + repos → generate a per-repo
 * Markdown summary card via the configured `claude` / `copilot` CLI.
 *
 * Density-first layout: a single toolbar row above the cards (since /
 * until / repos / force / generate / copy / clear) so the entire form
 * fits in the same band as every other PRMaster header. The cards
 * stretch full width below.
 */

import { useEffect, useState } from "react";
import { Copy, Download, Loader2, Sparkles, Trash2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  prmasterTauri,
  type AiSummaryParams,
  type SummaryCard,
} from "../../lib/tauri";
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "../shared/density";
import { RepoPicker } from "../shared/RepoPicker";

type CardState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; card: SummaryCard }
  | { status: "error"; message: string };

export function AiSummaryTab() {
  const [since, setSince] = useState(() =>
    isoDate(new Date(Date.now() - 6 * 86_400 * 1000)),
  );
  const [until, setUntil] = useState(() => isoDate(new Date()));
  const [force, setForce] = useState(false);

  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposFetching, setReposFetching] = useState(false);
  const [reposCachedAt, setReposCachedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [generating, setGenerating] = useState(false);

  async function refreshRepos() {
    setReposLoading(true);
    try {
      const result = await prmasterTauri.listAccessibleRepos();
      setRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
    } catch (err) {
      console.warn("[ai-summary] listAccessibleRepos failed:", err);
    } finally {
      setReposLoading(false);
    }
  }

  async function fetchRepos() {
    setReposFetching(true);
    try {
      const result = await prmasterTauri.fetchRepos();
      setRepos(result.repos);
      setReposCachedAt(result.cached_at_ms);
    } catch (err) {
      console.warn("[ai-summary] fetchRepos failed:", err);
    } finally {
      setReposFetching(false);
    }
  }

  useEffect(() => {
    void refreshRepos();
  }, []);

  async function generate() {
    if (selected.size === 0) return;
    const params0: Omit<AiSummaryParams, "repo"> = {
      since: `${since}T00:00:00Z`,
      until: `${until}T23:59:59Z`,
      force,
    };
    setGenerating(true);
    setCards((prev) => {
      const next = { ...prev };
      for (const repo of selected) next[repo] = { status: "loading" };
      return next;
    });
    for (const repo of selected) {
      try {
        const card = await prmasterTauri.aiSummary({ ...params0, repo });
        setCards((prev) => ({ ...prev, [repo]: { status: "ok", card } }));
      } catch (err) {
        setCards((prev) => ({
          ...prev,
          [repo]: { status: "error", message: formatError(err) },
        }));
      }
    }
    setGenerating(false);
  }

  async function copyAll() {
    const lines: string[] = [];
    for (const repo of selected) {
      const c = cards[repo];
      if (c?.status === "ok") {
        lines.push(`# ${repo}\n`, c.card.summary, "");
      }
    }
    if (lines.length === 0) return;
    await writeText(lines.join("\n"));
  }

  async function clearCache() {
    await prmasterTauri.clearAiCache();
    setCards({});
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        since={since}
        until={until}
        onSince={setSince}
        onUntil={setUntil}
        force={force}
        onForce={setForce}
        repos={repos}
        reposLoading={reposLoading}
        reposFetching={reposFetching}
        reposCachedAt={reposCachedAt}
        selected={selected}
        onToggleRepo={(repo) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(repo)) next.delete(repo);
            else next.add(repo);
            return next;
          })
        }
        onClearRepos={() => setSelected(new Set())}
        onReloadRepos={() => void refreshRepos()}
        onFetchRepos={() => void fetchRepos()}
        onGenerate={() => void generate()}
        onCopyAll={() => void copyAll()}
        onClearCache={() => void clearCache()}
        generating={generating}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/20">
        <div className="grid gap-2 p-2">
          {selected.size === 0 ? (
            <EmptyHint />
          ) : (
            [...selected].map((repo) => (
              <CardView key={repo} repo={repo} card={cards[repo]} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  since,
  until,
  onSince,
  onUntil,
  force,
  onForce,
  repos,
  reposLoading,
  reposFetching,
  reposCachedAt,
  selected,
  onToggleRepo,
  onClearRepos,
  onReloadRepos,
  onFetchRepos,
  onGenerate,
  onCopyAll,
  onClearCache,
  generating,
}: {
  since: string;
  until: string;
  onSince: (v: string) => void;
  onUntil: (v: string) => void;
  force: boolean;
  onForce: (v: boolean) => void;
  repos: string[];
  reposLoading: boolean;
  reposFetching: boolean;
  reposCachedAt: number | null;
  selected: Set<string>;
  onToggleRepo: (repo: string) => void;
  onClearRepos: () => void;
  onReloadRepos: () => void;
  onFetchRepos: () => void;
  onGenerate: () => void;
  onCopyAll: () => void;
  onClearCache: () => void;
  generating: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card/40 px-4 py-2">
      <Label htmlFor="since" className="text-xs text-muted-foreground">
        Since
      </Label>
      <Input
        id="since"
        type="date"
        value={since}
        onChange={(e) => onSince(e.target.value)}
        className="h-8 w-[140px]"
      />
      <Label htmlFor="until" className="text-xs text-muted-foreground">
        Until
      </Label>
      <Input
        id="until"
        type="date"
        value={until}
        onChange={(e) => onUntil(e.target.value)}
        className="h-8 w-[140px]"
      />

      <div className="flex min-w-[260px] flex-1 items-center gap-1">
        <div className="min-w-0 flex-1">
          <RepoPicker
            repos={repos}
            selected={selected}
            loading={reposLoading}
            fetching={reposFetching}
            cachedAtMs={reposCachedAt}
            compact
            onToggle={onToggleRepo}
            onClear={onClearRepos}
            onReload={onReloadRepos}
            onFetch={onFetchRepos}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={reposFetching}
          onClick={onFetchRepos}
          title="Fetch the full repo list from GitHub (ignores cache)"
        >
          {reposFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Fetch
        </Button>
      </div>

      <Label
        htmlFor="force"
        className="cursor-pointer text-xs font-normal text-muted-foreground"
      >
        <Checkbox
          id="force"
          checked={force}
          onCheckedChange={(v) => onForce(v === true)}
        />
        Force
      </Label>

      <Button
        size="sm"
        disabled={selected.size === 0 || generating}
        onClick={onGenerate}
      >
        {generating ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Sparkles className="size-4" />
        )}
        Generate{selected.size > 0 ? ` (${selected.size})` : ""}
      </Button>

      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onCopyAll}>
          <Copy className="size-4" />
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={onClearCache}>
          <Trash2 className="size-4" />
          Clear cache
        </Button>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <Panel className="border-dashed">
      <PanelContent className="flex flex-col items-center gap-2 py-8 text-center">
        <Sparkles className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Pick a date range + at least one repo, then click Generate.
        </p>
      </PanelContent>
    </Panel>
  );
}

function CardView({
  repo,
  card,
}: {
  repo: string;
  card: CardState | undefined;
}) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="font-mono">{repo}</PanelTitle>
        {card?.status === "ok" && (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary">{card.card.commit_count} commits</Badge>
            {card.card.cost_usd != null && (
              <Badge variant="outline">${card.card.cost_usd.toFixed(3)}</Badge>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void writeText(card.card.summary)}
              aria-label="Copy summary"
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        )}
      </PanelHeader>
      <PanelContent className="text-sm">
        {!card || card.status === "idle" ? (
          <span className="text-xs italic text-muted-foreground">
            Waiting…
          </span>
        ) : card.status === "loading" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Summarising…
          </div>
        ) : card.status === "error" ? (
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs whitespace-pre-wrap text-destructive">
            {card.message}
          </pre>
        ) : (
          <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap">
            {card.card.summary}
          </pre>
        )}
      </PanelContent>
    </Panel>
  );
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
