/**
 * Shared list/detail view used by Mine / To Review / Done tabs.
 *
 * Two modes, swapped via a navigation pattern (no inline expand):
 *
 *   - **list** — header (title + Refresh) + optional filter strip + the
 *     scrollable list of `PrCard`s.
 *   - **detail** — header (← Back + PR title + Refresh) + the single
 *     selected PR's `PrDetailPanel`, occupying the entire content area.
 *
 * Selection lives in the global store (`state.selectedPrId`) so it
 * persists across tab switches; the detail mode kicks in whenever the
 * selected row belongs to *this* list.
 */

import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@zen-tools/ui";
import {
  enrichedId,
  usePrMasterStore,
} from "../../store/prmaster-store";
import type { EnrichedPullRequest } from "../../lib/tauri";
import { Panel, PanelContent } from "./density";
import { PrCard } from "./PrCard";
import { PrDetailPanel } from "./PrDetailPanel";

interface Props {
  title: string;
  rows: EnrichedPullRequest[];
  loading: boolean;
  error: string | null;
  emptyText: string;
  onRefresh: () => void;
  /** Optional filter strip rendered as its own band beneath the header. */
  filterBar?: React.ReactNode;
}

export function EnrichedListView({
  title,
  rows,
  loading,
  error,
  emptyText,
  onRefresh,
  filterBar,
}: Props) {
  const { state, dispatch } = usePrMasterStore();

  // Resolve the selected row *in this list* — selection persists across
  // tabs, so we ignore selections that don't belong here.
  const selectedRow = state.selectedPrId
    ? rows.find((r) => enrichedId(r) === state.selectedPrId)
    : undefined;

  if (selectedRow) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* Centred title rail: Back pinned left, Refresh pinned right
            via absolute positioning so the middle column ignores their
            widths and the PR title actually lands in the visual centre
            of the bar (rather than getting nudged sideways by whichever
            side button happens to be wider). */}
        <header className="relative flex h-9 shrink-0 items-center border-b bg-card/40 px-2">
          <div className="absolute inset-y-0 left-2 flex items-center">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => dispatch({ type: "select", id: null })}
              aria-label="Back to list"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          </div>
          <div className="mx-auto flex min-w-0 max-w-[60%] items-baseline gap-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {selectedRow.pr.repository.nameWithOwner}#
              {selectedRow.pr.number}
            </span>
            <span
              className="truncate text-sm font-medium"
              title={selectedRow.pr.title}
            >
              {selectedRow.pr.title}
            </span>
          </div>
          <div className="absolute inset-y-0 right-2 flex items-center">
            <Button
              size="xs"
              variant="ghost"
              disabled={loading}
              onClick={onRefresh}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Refresh
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          <PrDetailPanel
            pr={selectedRow}
            currentUser={state.currentUser}
            onActionDone={onRefresh}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-card/40 px-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{title}</h2>
          <span className="text-xs text-muted-foreground">
            {rows.length} open
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh
        </Button>
      </header>

      {filterBar && (
        <div className="shrink-0 border-b bg-card/20 px-3 py-1.5">
          {filterBar}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {error && (
          <Panel className="mb-2 border-destructive/40 bg-destructive/5">
            <PanelContent className="p-2 text-xs text-destructive">
              {error}
            </PanelContent>
          </Panel>
        )}

        {rows.length === 0 && !loading && !error && (
          <div className="my-12 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const id = enrichedId(row);
            return (
              <PrCard
                key={id}
                enriched={row}
                selected={false}
                onSelect={() => dispatch({ type: "select", id })}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
