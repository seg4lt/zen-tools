/**
 * SQL editor — wraps the shared `CodeEditor` with `@codemirror/lang-sql`,
 * the right dialect, and a schema-aware autocomplete that pulls column
 * lists from the local schema cache.
 *
 * Behaviour summary:
 *
 *  - Tables and columns flow into CodeMirror via a `Compartment`-wrapped
 *    `sql({ schema, dialect })` extension. The compartment lets us
 *    reconfigure on every cache update without rebuilding the editor.
 *  - Whenever the buffer changes (debounced), we extract table
 *    references with `extractTableReferences` and ask the shared
 *    `schema-cache` façade to ensure they're loaded. Anything missing
 *    triggers a backend fetch + cache upsert; stale rows refresh in the
 *    background.
 *  - Subscribing to the façade's events feeds incremental updates back
 *    into the compartment so completions appear as the cache populates.
 *  - `Opt+Enter` opens the actions popup (reindex table at cursor /
 *    reindex statement / reindex everything cached for the connection).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Compartment, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  sql,
  PostgreSQL,
  MSSQL,
  schemaCompletionSource,
  keywordCompletionSource,
  type SQLConfig,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  CodeEditor,
  type CodeEditorHandle,
} from "@zen-tools/editor";
import { useTheme } from "@/hooks/use-theme";
import type {
  DbDriverId,
  DbTableDescription,
  DbTableSummary,
} from "../lib/tauri";
import {
  ensureCatalog,
  ensureTables,
  ensureTablesForSql,
  forceReindex,
  invalidate,
  readCached,
  readCachedForDatabase,
  readCatalog,
  subscribe as subscribeSchemaCache,
  subscribeCatalog,
} from "../lib/schema-cache";
import {
  extractAliasMap,
  extractTableReferences,
  tableReferenceAtOffset,
  type AliasMap,
} from "../lib/sql-references";
import { statementAtCursor } from "../lib/sql-statements";
import { extractPlaceholders } from "../lib/sql-placeholders";
import { SqlActionsPopup, type SqlAction } from "./sql-actions-popup";

export type SqlEditorHandle = CodeEditorHandle;

/**
 * Cap on how many tables the catalog-load eager prefetch fans out. On
 * a huge schema (>100 tables), we'd otherwise round-trip every single
 * one; lazy fetches via the typing-debounce path still cover the
 * tail. 100 strikes the right balance for normal apps without
 * punishing big-data installations.
 */
const PREFETCH_LIMIT = 100;

export interface SqlEditorProps {
  value: string;
  driver: DbDriverId;
  /** Active connection — drives schema-cache lookups. `null` disables
   * autocomplete (we just render keywords + dialect). */
  connectionId?: string | null;
  /** Active database for the connection (Postgres: bound DB; MSSQL:
   * `USE` target). Required for cache lookups. */
  database?: string | null;
  /** Active schema (Postgres `search_path` head). MSSQL: the schema the
   * user expects to type unqualified table names against. */
  schema?: string | null;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  /** Run handler — fired on Mod-Enter. */
  onRun?: () => void;
  vimMode?: boolean;
  /** `Ctrl+W h/j/k/l` — move focus between split panes. */
  onMoveFocus?: (dir: "h" | "j" | "k" | "l") => void;
  /** `Ctrl+O` — workspace-level jump back. Return `true` if handled. */
  onJumpBack?: () => boolean;
  /** `Ctrl+I` — workspace-level jump forward. */
  onJumpForward?: () => boolean;
  imperativeRef?: Ref<SqlEditorHandle>;
}

export function SqlEditor({
  value,
  driver,
  connectionId,
  database,
  schema,
  onChange,
  onSave,
  onRun,
  vimMode = true,
  onMoveFocus,
  onJumpBack,
  onJumpForward,
  imperativeRef,
}: SqlEditorProps) {
  const { theme } = useTheme();
  const dialect = driver === "postgres" ? PostgreSQL : MSSQL;

  // Stable Compartment + reconfigure ref. The compartment lives across
  // re-renders so we can swap `sql({schema})` without remounting.
  const sqlCompartmentRef = useRef<Compartment | null>(null);
  if (!sqlCompartmentRef.current) {
    sqlCompartmentRef.current = new Compartment();
  }
  const sqlCompartment = sqlCompartmentRef.current;

  const viewRef = useRef<EditorView | null>(null);
  const captureViewRef = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

  /**
   * Latest `reconfigure` closure exposed by the cache/catalog effect
   * below. Used by:
   *   - `scheduleEnsure` to refresh alias completions on every
   *     debounced doc-change.
   *   - `handleRun` to refresh aliases before query execution so a
   *     just-pasted statement's aliases work in the result-tab
   *     follow-up.
   */
  const reconfigureRef = useRef<(() => void) | null>(null);

  // Popup state — lives in React so positioning + Esc handling is
  // straightforward. CodeMirror only signals open/close.
  const [popup, setPopup] = useState<{
    x: number;
    y: number;
    actions: SqlAction[];
  } | null>(null);

  // ── Build the SQL extension from current catalog + cache contents ───
  //
  // The catalog gives us schema names + every qualified table, so cold
  // completions like `zen_**` → `zen_db` and `zen_db.metri**` →
  // `zen_db.metrics` work the moment the editor mounts. The cache adds
  // per-table column lists on top once `ensureTables` (or the
  // background refresh) has populated it.
  //
  // **Important**: we no longer bail on missing `schema`. A null
  // `schema` just means the user hasn't explicitly picked one in the
  // explorer yet — most users never do. We fall back to the dialect's
  // conventional default (`public` for Postgres, `dbo` for MSSQL) and
  // still build the full schema config from the catalog. Without this
  // fallback the editor would silently render with keyword-only
  // completion (no schemas, no tables, no columns).
  const effectiveSchema =
    schema ?? (driver === "postgres" ? "public" : "dbo");
  const buildSqlExtension = useCallback(
    (currentDoc?: string): Extension => {
      if (!connectionId || !database) {
        // No connection → fall back to lang-sql's stock setup
        // (keyword popups only). We still want autocomplete to work
        // for plain SQL editing.
        return [
          sql({ dialect, upperCaseKeywords: true }),
          autocompletion({
            activateOnTyping: true,
            defaultKeymap: true,
          }),
        ];
      }
      const cached = readCached(connectionId, database, effectiveSchema, []);
      const catalog = readCatalog(connectionId, database);
      const aliases = currentDoc ? extractAliasMap(currentDoc) : {};
      const config = buildSqlConfig(
        dialect,
        effectiveSchema,
        cached,
        catalog,
        aliases,
      );

      // Build an explicit source list. Order matters — earlier
      // sources contribute completions first; results merge.
      //
      // 1. **Alias source (ours)** — handles `<alias>.<col>` even
      //    when lang-sql's schema lookup would miss because the
      //    alias isn't a real table. Reads aliases dynamically from
      //    the FULL buffer on every invocation, so a forward-typed
      //    `select e.<col> from events e` resolves the moment the
      //    user re-triggers completion (Ctrl+Space) at `e.<col>`.
      //
      // 2. **Schema source (lang-sql)** — handles real
      //    `<schema>.<table>.<col>` and bare `<table>.<col>` from
      //    the registered schema config.
      //
      // 3. **Keyword source (lang-sql)** — `SELECT`, `FROM`,
      //    `WHERE`, dialect-specific tokens. Always available.
      return [
        sql(config),
        autocompletion({
          activateOnTyping: true,
          defaultKeymap: true,
          override: [
            buildAliasCompletionSource({
              connectionId,
              database,
              defaultSchema: effectiveSchema,
            }),
            schemaCompletionSource(config),
            keywordCompletionSource(dialect, true),
          ],
        }),
      ];
    },
    [connectionId, database, effectiveSchema, dialect],
  );

  // The full extensions builder passed down to `CodeEditor`. We rebuild
  // when the compartment-controlled SQL config changes (driver swap,
  // connection swap), then rely on `compartment.reconfigure(...)` for
  // incremental cache updates.
  //
  // Note: the Opt+Enter binding lives in `CodeEditor` itself (via the
  // `onAltEnter` prop), not here — only that path lands at
  // `Prec.highest`, which is what's needed to outrun vim's keymap and
  // `defaultKeymap`'s built-in `splitLine` on `Alt-Enter`.
  //
  // **`autocompletion()` is mandatory**: `@codemirror/lang-sql` only
  // registers a completion *source* via its `LanguageSupport`. The
  // popup itself, the trigger-on-typing wiring, and the
  // `Tab`/`Enter`/`Esc` keymap all live in `@codemirror/autocomplete`.
  // Without this extension the source never runs and no completions
  // ever appear — even for plain SQL keywords.
  const buildExtensions = useMemo(
    () =>
      (_env: { isDark: boolean }): Extension[] => [
        // The compartment now holds BOTH `sql({...})` and
        // `autocompletion({override: [...]})` — see
        // `buildSqlExtension`. Single source of truth for the SQL
        // language layer + completion config; reconfigured atomically.
        sqlCompartment.of(buildSqlExtension(value)),
        // `:name` placeholder italicisation — purely visual hint
        // that running the query will open the placeholder prompt
        // dialog. Re-runs on every doc change; the helper skips
        // string literals + comments so `'time :12'` stays normal.
        placeholderDecorationPlugin,
        EditorView.theme({
          ".cm-zen-sql-placeholder": {
            fontStyle: "italic",
            color: "var(--color-primary, currentColor)",
            opacity: "0.85",
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }
          // (a) Pump the typing-debounced ensure-tables / reconfigure.
          scheduleEnsure(update.state.doc.toString());
          // (b) Trigger column autocomplete the moment the user types
          //     `.` after an identifier (e.g. `e.|`, `users.|`,
          //     `public.users.|`). CM6's `activateOnTyping` only fires
          //     for word chars, so without this the popup never opens
          //     at the dot — the user would have to press Ctrl+Space
          //     manually to see column suggestions.
          let dotInserted = false;
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, ins) => {
            if (ins.toString().endsWith(".")) dotInserted = true;
          });
          if (dotInserted) {
            // Defer one tick so the cursor position update settles
            // before the completion source reads the parse tree.
            queueMicrotask(() => startCompletion(update.view));
          }
        }),
      ],
    // Identity is stable for these refs/closures; deps that actually
    // matter (connectionId, database, schema, driver) are funnelled via
    // `buildSqlExtension` and the explicit reconfigure effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildSqlExtension],
  );

  // ── Ensure-tables debounce ──────────────────────────────────────────
  const ensureTimerRef = useRef<number | null>(null);
  const scheduleEnsure = useCallback(
    (doc: string) => {
      if (!connectionId || !database) return;
      if (ensureTimerRef.current) {
        window.clearTimeout(ensureTimerRef.current);
      }
      ensureTimerRef.current = window.setTimeout(() => {
        // Refresh alias-driven completions every debounce tick so
        // typing `FROM users u` immediately makes `u.<col>` resolve
        // (once columns land). Skips the work if reconfigure isn't
        // wired yet (mid-mount).
        reconfigureRef.current?.();
        // Cross-schema refs are dispatched per-schema by the helper.
        ensureTablesForSql(connectionId, database, effectiveSchema, doc);
      }, 150);
    },
    [connectionId, database, effectiveSchema],
  );

  // Kick an initial ensure when the buffer or connection changes.
  useEffect(() => {
    scheduleEnsure(value);
    return () => {
      if (ensureTimerRef.current) {
        window.clearTimeout(ensureTimerRef.current);
        ensureTimerRef.current = null;
      }
    };
    // value is intentionally not in deps — we read it on demand on
    // every doc change. We DO want a re-prefetch on connection swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, database, effectiveSchema]);

  // ── Push catalog + cache updates back into the compartment ──────────
  //
  // Four triggers reconfigure the editor's `sql({schema})`:
  //
  //   1. Cold catalog load (`ensureCatalog`) lands → schema names and
  //      qualified table names appear in completions.
  //   2. `describeTable` lands a fresh row → that table's columns
  //      appear in completions.
  //   3. Connection / database / schema swap → drop everything stale.
  //   4. Doc change → alias map updates so `de.<col>` resolves to the
  //      current `FROM <table> de` mapping. Shares the typing-debounce
  //      tick driving ensure-tables; not on every keystroke.
  useEffect(() => {
    if (!connectionId || !database) return;
    const reconfigure = () => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc.toString();
      view.dispatch({
        effects: sqlCompartment.reconfigure(buildSqlExtension(doc)),
      });
      // If the cursor is currently sitting in an `<ident>.<partial>`
      // position, re-trigger autocomplete so the freshly resolved
      // aliases / cached columns surface without the user having to
      // tap Ctrl+Space themselves. We only fire when the popup is
      // either inactive or already showing (i.e. not pending) to
      // avoid jittering an in-flight request.
      const head = view.state.selection.main.head;
      const before = view.state.doc.sliceString(
        Math.max(0, head - 64),
        head,
      );
      if (
        /[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]*$/.test(before) &&
        completionStatus(view.state) !== "pending"
      ) {
        queueMicrotask(() => startCompletion(view));
      }
    };
    // Reconfigure immediately — catalog/cache may already be populated
    // from a prior mount of the editor on this connection.
    reconfigure();

    // Kick the catalog load. ensureCatalog dedupes concurrent callers,
    // so calling it on every editor mount is fine.
    //
    // **Eager column prefetch**: once the catalog lands, schedule
    // describe_tables_bulk for every table the connection can see,
    // bucketed by schema, capped at PREFETCH_LIMIT total. The default
    // schema is sorted to the front so its tables get cached first
    // (most user queries hit it). Backend's `force=false` path is
    // idempotent — already-cached tables short-circuit; missing/stale
    // ones get background-refreshed and emit progress events the user
    // sees on the cache-status badge.
    //
    // Why cover non-default schemas? A `FROM events e` whose `events`
    // lives in `app` would otherwise stay un-cached forever (the
    // typing-debounce path needs the catalog to know events is in
    // `app`, but it only fires on type — chicken-and-egg). Pre-warming
    // every schema in the catalog breaks that cycle.
    // Eager column prefetch is gated on the user having EXPLICITLY
    // picked a schema from the context-picker dropdown (the `schema`
    // prop, NOT the `effectiveSchema` fallback). Two reasons:
    //
    //   1. On a multi-schema cluster the prior "fan out across the
    //      first 100 tables sorted by default schema" approach still
    //      lights up the progress chip with dozens of describe jobs
    //      the user didn't ask for. Picking nothing → indexing
    //      nothing matches the principle of least surprise.
    //   2. The `effectiveSchema` fallback (`public` / `dbo`) is a
    //      completion-time convenience for typing bare table names.
    //      It should NOT trigger background work — when the user
    //      hits Run on a query referencing real tables,
    //      `ensureTablesForSql` will fetch precisely those tables,
    //      bucketed by their actual schema (resolved through the
    //      catalog).
    //
    // The catalog itself (lightweight name listing) still loads
    // unconditionally so qualified-table autocomplete works the
    // moment the editor opens.
    void ensureCatalog(connectionId, database).catch(() => {
      // Soft-fail; the editor still works with whatever the cache
      // has, just without cold-completion catalog names.
    });

    if (schema) {
      void ensureCatalog(connectionId, database)
        .then((catalog) => {
          const inSchema = catalog.filter((t) => t.schema === schema);
          if (inSchema.length === 0) return;

          // Skip the round-trip entirely when every catalog entry
          // for this schema is already in the in-memory mirror
          // (i.e. fresh enough that we've seen its description in
          // this session). The backend's TTL-based stale check is
          // still authoritative — when the mirror is missing rows,
          // we delegate to `ensureTables` which sends them to the
          // backend as `force=false`; rows older than
          // `DEFAULT_TTL_MS` come back cached now and queue a
          // silent background refresh, missing rows fetch
          // synchronously. Either way we avoid the "indexing N
          // tables" chip storm on every editor focus.
          const cachedNow = readCachedForDatabase(connectionId, database)
            .filter((d) => d.schema === schema)
            .map((d) => d.name);
          const cachedSet = new Set(cachedNow);
          const stale = inSchema
            .filter((t) => !cachedSet.has(t.name))
            .slice(0, PREFETCH_LIMIT)
            .map((t) => t.name);
          if (stale.length === 0) return;

          void ensureTables(connectionId, database, schema, stale).catch(
            () => {},
          );
        })
        .catch(() => {
          // Soft-fail; surfaces above will retry on next mount.
        });
    }

    const unsubCache = subscribeSchemaCache((event) => {
      if (event.connectionId === connectionId && event.database === database) {
        reconfigure();
      }
    });
    const unsubCatalog = subscribeCatalog((event) => {
      if (event.connectionId === connectionId && event.database === database) {
        reconfigure();
      }
    });

    // Expose `reconfigure` to scheduleEnsure / handleRun via a ref so
    // doc-change-debounced ticks can pick up new alias mappings
    // without re-instantiating this effect.
    reconfigureRef.current = reconfigure;
    return () => {
      reconfigureRef.current = null;
      unsubCache();
      unsubCatalog();
    };
    // Note: depend on `schema` (the user-picked dropdown value) rather
    // than `effectiveSchema` (which has the public/dbo fallback) — the
    // eager-prefetch branch above is gated on `schema`, so re-running
    // on a fallback change would just no-op.
  }, [connectionId, database, schema, effectiveSchema, dialect, sqlCompartment]);

  // ── Opt+Enter actions popup ─────────────────────────────────────────
  //
  // Always shows the popup — even when no actions apply, the user
  // sees an empty-state row explaining why ("Connect to a database
  // first" etc.). That's much less confusing than a silently-failing
  // shortcut.
  const openActionsPopup = useCallback(
    (view: EditorView) => {
      const head = view.state.selection.main.head;
      const coords = view.coordsAtPos(head) ?? { left: 0, bottom: 0 };
      const doc = view.state.doc.toString();
      const refAtCursor = tableReferenceAtOffset(doc, head);
      const stmt = statementAtCursor(doc, head);
      const stmtRefs = extractTableReferences(stmt?.sql ?? "");

      // Same dialect-conventional fallback the autocomplete config
      // uses (`public` for Postgres, `dbo` for MSSQL) — keeps reindex
      // actions and completions targeting the same schema even when
      // the user hasn't picked one in the explorer.
      const fallbackSchema = effectiveSchema;

      const actions: SqlAction[] = [];

      if (refAtCursor && connectionId && database) {
        actions.push({
          id: "reindex-cursor",
          label: `Reindex \`${qualified(refAtCursor.schema, refAtCursor.table)}\``,
          run: async () => {
            await forceReindex(
              connectionId,
              database,
              refAtCursor.schema ?? fallbackSchema,
              [refAtCursor.table],
            );
          },
        });
      }

      if (stmtRefs.length && connectionId && database) {
        actions.push({
          id: "reindex-statement",
          label: `Reindex tables in current statement (${stmtRefs.length})`,
          run: async () => {
            // Dispatch one bulk per (db, schema) bucket.
            const byBucket = new Map<string, string[]>();
            for (const r of stmtRefs) {
              const sch = r.schema ?? fallbackSchema;
              const list = byBucket.get(sch) ?? [];
              list.push(r.table);
              byBucket.set(sch, list);
            }
            await Promise.all(
              [...byBucket].map(([sch, names]) =>
                forceReindex(connectionId, database, sch, names),
              ),
            );
          },
        });
      }

      if (connectionId && database) {
        actions.push({
          id: "invalidate-schema",
          label: `Invalidate cache for \`${fallbackSchema}\` (next type re-fetches)`,
          run: async () => {
            await invalidate(connectionId, database, fallbackSchema, []);
          },
        });
      }

      // Always-on diagnostic: open the popup even when no real actions
      // apply, with a single "informational" row. Clicking it just
      // closes the popup. Without this the shortcut "doesn't work"
      // when the user fires it on an empty buffer or a disconnected
      // connection.
      if (actions.length === 0) {
        const reason = !connectionId
          ? "Open a database connection first"
          : !database
            ? "Pick an active database"
            : "Place the cursor on a table reference, or start writing FROM …";
        actions.push({
          id: "no-actions",
          label: reason,
          run: () => {
            // No-op — clicking just dismisses the popup.
          },
        });
      }

      setPopup({ x: coords.left, y: coords.bottom + 4, actions });
    },
    [connectionId, database, effectiveSchema],
  );

  const closePopup = useCallback(() => setPopup(null), []);

  // Esc / outside-click is owned by the popup component; we just need
  // to refocus the editor when the popup closes.
  useEffect(() => {
    if (popup) return;
    viewRef.current?.focus();
  }, [popup]);

  return (
    <>
      <CodeEditor
        value={value}
        onChange={onChange}
        onSave={onSave}
        onRunLine={onRun ? () => onRun() : undefined}
        onAltEnter={openActionsPopup}
        vimMode={vimMode}
        isDark={theme === "dark"}
        imperativeRef={imperativeRef}
        extensions={buildExtensions}
        onView={captureViewRef}
        onMoveFocus={onMoveFocus}
        onJumpBack={onJumpBack}
        onJumpForward={onJumpForward}
      />
      {popup ? (
        <SqlActionsPopup
          x={popup.x}
          y={popup.y}
          actions={popup.actions}
          onClose={closePopup}
        />
      ) : null}
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * CodeMirror ViewPlugin that paints every `:name` placeholder with a
 * `cm-zen-sql-placeholder` mark decoration. Runs on mount and on
 * every doc change.
 *
 * The decoration is purely cosmetic — substitution still happens
 * upstream in `DatabaseExplorerView` at run time. We do this here so
 * the user can see at a glance which tokens will trigger the prompt
 * dialog when they hit ⌘↵.
 *
 * Cost is bounded by the `extractPlaceholders` walker (linear in doc
 * size, no regex backtracking). For very large buffers (>100k chars)
 * this could be moved behind a viewport-only scan, but the current
 * SQL files are tiny relative to the typical Markdown / code buffers
 * the rest of the app handles, so the simple full-doc scan is fine.
 */
const placeholderMark = Decoration.mark({ class: "cm-zen-sql-placeholder" });

function buildPlaceholderDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc.toString();
  for (const occ of extractPlaceholders(doc)) {
    builder.add(occ.from, occ.to, placeholderMark);
  }
  return builder.finish();
}

const placeholderDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPlaceholderDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = buildPlaceholderDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);


/**
 * Build the `@codemirror/lang-sql` config from:
 *
 *   - **catalog** — every relation visible in the connected database
 *     (cold-load, no columns). Drives `zen_**` → `zen_db` and
 *     `zen_db.metri**` → `zen_db.metrics`.
 *   - **cached descriptions** — tables we've previously called
 *     `describe_table` on. Drives `zen_db.metrics.<col>` column
 *     completions.
 *   - **aliases** — alias-to-table mappings parsed from the buffer
 *     (`FROM daily_event_counts de` → `de` resolves to
 *     `daily_event_counts`). Drives `de.<col>` completions by
 *     registering the alias as a synthetic schema entry whose columns
 *     come from the resolved table's cached description.
 *
 * Tables in the user's "current schema" are registered both bare
 * (`users`) and qualified (`public.users`); tables from other schemas
 * are registered qualified only.
 *
 * The catalog seeds entries with `[]` columns; once a table's
 * description lands in the cache, we replace `[]` with the actual
 * column list. lang-sql's CompletionLevel walks the schema map by
 * dotted key, so `zen_db.metrics.<col>` only works once the column
 * list is populated.
 *
 * Alias resolution is a no-op until the resolved table is in `cached`.
 * When the cache fills (typing-debounce → ensure-tables → backend
 * fetch → schema-cache-updated event → reconfigure), the alias entry
 * picks up the columns automatically.
 */
function buildSqlConfig(
  dialect: typeof PostgreSQL | typeof MSSQL,
  defaultSchema: string,
  cached: DbTableDescription[],
  catalog: DbTableSummary[],
  aliases: AliasMap,
): SQLConfig {
  const schemaCfg: NonNullable<SQLConfig["schema"]> = {};
  const tableCompletions: Completion[] = [];
  const seen = new Set<string>();

  // Pass 1: catalog. Seeds every relation with empty columns so the
  // qualified-name autocomplete works cold.
  for (const sum of catalog) {
    const qualifiedKey = `${sum.schema}.${sum.name}`;
    schemaCfg[qualifiedKey] = [];
    if (sum.schema === defaultSchema && !seen.has(`bare:${sum.name}`)) {
      schemaCfg[sum.name] = [];
      tableCompletions.push({
        label: sum.name,
        type: sum.kind === "view" ? "class" : "type",
        detail: sum.kind === "view" ? "view" : "table",
      });
      seen.add(`bare:${sum.name}`);
    }
    tableCompletions.push({
      label: qualifiedKey,
      type: sum.kind === "view" ? "class" : "type",
      detail: sum.kind === "view" ? `${sum.schema} (view)` : sum.schema,
    });
  }

  // Pass 2: cached descriptions. Overwrites the empty arrays from
  // pass 1 with the actual column completions wherever we have them.
  // Index by `<schema>.<name>` and bare `<name>` so the alias pass
  // below can look up columns in O(1).
  const colsByQualified: Record<string, Completion[]> = {};
  const colsByBare: Record<string, Completion[]> = {};
  for (const desc of cached) {
    const cols = desc.columns.map((c) => columnToCompletion(c));
    const qualifiedKey = `${desc.schema}.${desc.name}`;
    schemaCfg[qualifiedKey] = cols;
    colsByQualified[qualifiedKey] = cols;
    colsByBare[desc.name] = cols;
    if (desc.schema === defaultSchema) {
      schemaCfg[desc.name] = cols;
      // If the catalog hadn't seen this table (e.g. just-created),
      // also push it into the table-completion list now.
      if (!seen.has(`bare:${desc.name}`)) {
        tableCompletions.push({
          label: desc.name,
          type: desc.kind === "view" ? "class" : "type",
          detail: desc.kind === "view" ? "view" : "table",
        });
        seen.add(`bare:${desc.name}`);
      }
    }
  }

  // Pass 3: aliases. For each `alias → table` from the buffer, look
  // up the resolved table's columns and register the alias as a
  // synthetic schema entry. Resolution is best-effort with a
  // three-tier fallback for bare refs (no schema):
  //
  //   1. default-schema match (`public.events`).
  //   2. ANY cached schema with the table name (covers `events`
  //      living in a non-default schema like `app`).
  //   3. nothing — register an empty entry so the alias key at
  //      least exists; columns will fill in once the cache lands.
  //
  // We **skip the alias entirely** when no columns can be found,
  // because lang-sql's completion source treats an empty-array entry
  // as "table exists but I have no columns", which suppresses the
  // popup entirely. Letting lang-sql see no entry at all means it
  // falls through to its generic word-rank suggestions instead.
  for (const [alias, ref] of Object.entries(aliases)) {
    if (alias in schemaCfg) {
      // Don't shadow real tables that happen to share the alias name.
      continue;
    }
    let cols: Completion[] | undefined;
    if (ref.schema) {
      cols = colsByQualified[`${ref.schema}.${ref.table}`];
    } else {
      cols =
        colsByBare[ref.table] ??
        colsByQualified[`${defaultSchema}.${ref.table}`];
      if (!cols) {
        // Fallback: any cached table that matches the bare name,
        // regardless of schema. Picks up `app.events` when the user
        // wrote `FROM events e` without schema-qualifying.
        const anyMatch = cached.find((d) => d.name === ref.table);
        if (anyMatch) {
          cols = anyMatch.columns.map((c) => columnToCompletion(c));
        }
      }
    }
    if (cols && cols.length > 0) {
      schemaCfg[alias] = cols;
    }
  }

  return {
    dialect,
    upperCaseKeywords: true,
    schema: schemaCfg,
    defaultSchema,
    tables: tableCompletions.length ? tableCompletions : undefined,
  };
}

function columnToCompletion(c: DbTableDescription["columns"][number]): Completion {
  const flags = [c.isPrimaryKey ? "PK" : null, c.nullable ? null : "NOT NULL"]
    .filter(Boolean)
    .join(" · ");
  return {
    label: c.name,
    type: c.isPrimaryKey ? "keyword" : "property",
    detail: c.dataType,
    info: flags
      ? `${c.dataType} · ${flags}`
      : c.dataType + (c.default ? ` · default ${c.default}` : ""),
  };
}

function qualified(schema: string | null, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/**
 * Custom completion source for `<alias>.<column>` references. Runs
 * before lang-sql's own schema source so it can fill the gap where
 * the alias isn't (yet) a registered key in the schema config.
 *
 * The source reads aliases from the **full** buffer on every
 * invocation, not just from a baked-in snapshot — so the moment the
 * user finishes typing `FROM events e` and re-triggers completion at
 * `e.<col>` (Ctrl+Space, or by typing one more character), the alias
 * resolves and columns appear. No reconfigure required.
 *
 * Returns `null` when:
 *   - The cursor isn't at an `<ident>.<partial>` position.
 *   - The leading identifier isn't an alias **and** isn't a cached
 *     real table (let lang-sql's schemaCompletionSource handle it).
 *   - The resolved table has no columns in the in-memory mirror yet
 *     (typing-debounce will fetch them shortly; the user can retry).
 */
function buildAliasCompletionSource(args: {
  connectionId: string;
  database: string;
  defaultSchema: string;
}): CompletionSource {
  const { connectionId, database, defaultSchema } = args;
  return (context: CompletionContext): CompletionResult | null => {
    // Match `<ident>.<partial>` where the cursor is right after
    // `<partial>`. `<ident>` may itself be qualified
    // (`schema.table.col` — last dot wins). Quoted/bracketed idents
    // are NOT matched here; lang-sql's own source handles those.
    const before = context.matchBefore(
      /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.[A-Za-z0-9_]*/,
    );
    if (!before) return null;

    const text = before.text;
    const lastDot = text.lastIndexOf(".");
    const headIdent = text.slice(0, lastDot);
    // `text.slice(lastDot + 1)` is the partial column name the user
    // is typing — autocompletion uses it for ranking via `validFor`,
    // so we don't need to pass it explicitly.
    const completionFrom = before.from + lastDot + 1;

    // Resolve aliases from the full buffer (not just up-to-cursor).
    // This is what makes forward-typed `SELECT e.col … FROM events e`
    // work — by the time the user hits Ctrl+Space, the FROM clause
    // has been written.
    const fullDoc = context.state.doc.toString();
    const aliases = extractAliasMap(fullDoc);

    // The interesting "head" is the segment immediately before the
    // last dot — for `users.col` that's `users`; for
    // `public.users.col` it's `users` (we drop the `public.` prefix
    // for alias lookup, since aliases never carry a schema).
    const headSegments = headIdent.split(".");
    const lookup = headSegments[headSegments.length - 1];

    let target: { schema: string | null; table: string } | null = null;
    if (lookup in aliases) {
      target = aliases[lookup];
    } else if (headSegments.length >= 2) {
      // Caller wrote `<schema>.<table>.<col>` — treat as a real
      // qualified ref so we can still satisfy from cache.
      target = {
        schema: headSegments[headSegments.length - 2],
        table: headSegments[headSegments.length - 1],
      };
    } else {
      // Bare ident — could be a real table in any schema.
      target = { schema: null, table: lookup };
    }

    if (!target) return null;

    // Resolve target.table → DbTableDescription via the in-memory
    // mirror. Prefer default-schema match; fall back to any schema
    // that holds a table with the same name. Cheap O(N) over the
    // mirror; N is bounded by PREFETCH_LIMIT.
    const all = readCachedForDatabase(connectionId, database);
    const desc = target.schema
      ? all.find(
          (d) => d.schema === target!.schema && d.name === target!.table,
        )
      : all.find(
          (d) => d.schema === defaultSchema && d.name === target!.table,
        ) ?? all.find((d) => d.name === target!.table);

    if (!desc) return null;

    return {
      from: completionFrom,
      options: desc.columns.map((c) => columnToCompletion(c)),
      // Keep the popup open as the user keeps typing column-name
      // characters; close it as soon as a non-word char (or another
      // dot) appears.
      validFor: /^[A-Za-z0-9_]*$/,
    };
  };
}
