/**
 * Shared list+inline-detail view used by Mine / To Review / Done tabs.
 *
 * Header bar matches the rest of the PRMaster tool (10-px tall, 16-px
 * horizontal padding, ghost refresh button on the right). PR rows render
 * via `PrCard`; the inline detail panel renders directly below the
 * selected row.
 */

import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  enrichedId,
  usePrMasterStore,
} from "../../store/prmaster-store";
import type { EnrichedPullRequest } from "../../lib/tauri";
import { PrCard } from "./PrCard";
import { PrDetailPanel } from "./PrDetailPanel";

interface Props {
  title: string;
  rows: EnrichedPullRequest[];
  loading: boolean;
  error: string | null;
  emptyText: string;
  onRefresh: () => void;
}

export function EnrichedListView({
  title,
  rows,
  loading,
  error,
  emptyText,
  onRefresh,
}: Props) {
  const { state, dispatch } = usePrMasterStore();

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

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {error && (
          <Card className="mb-3 border-destructive/40 bg-destructive/5">
            <CardContent className="p-3 text-sm text-destructive">
              {error}
            </CardContent>
          </Card>
        )}

        {rows.length === 0 && !loading && !error && (
          <div className="my-12 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const id = enrichedId(row);
            const isSelected = id === state.selectedPrId;
            return (
              <div key={id} className="flex flex-col gap-2">
                <PrCard
                  pr={row.pr}
                  selected={isSelected}
                  decision={row.reviewDecision}
                  onSelect={() =>
                    dispatch({
                      type: "select",
                      id: isSelected ? null : id,
                    })
                  }
                />
                {isSelected && (
                  <PrDetailPanel
                    pr={row}
                    currentUser={state.currentUser}
                    onActionDone={onRefresh}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
