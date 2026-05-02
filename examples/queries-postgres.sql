-- ─────────────────────────────────────────────────────────────────────
-- Copy-paste sample queries — **Postgres dialect**.
--
-- Targets the seed in `docker/postgres/01-init.sql`. The MSSQL
-- counterpart lives in `examples/queries-mssql.sql`. Most queries
-- here use Postgres-only syntax: `now() - interval '7 days'`,
-- `array_agg`, `metadata @> '...'` (jsonb GIN), `WITH RECURSIVE`,
-- `EXPLAIN (FORMAT JSON, …)`, `CALL proc(...)`. See the MSSQL file
-- for the T-SQL equivalents.
--
-- Open this file in the SQL editor, place the cursor on any
-- statement, hit Cmd+Enter (or click Run). Use the **Run with…**
-- dropdown for the section-6/7 queries (☑ Plan ☑ Actuals → perf
-- visualizer) and the section-8 queries (☑ Locks → row/page/table
-- lock telemetry).
--
-- Use cases the queries cover:
--   1.  Smoke tests             — does the connection, the editor,
--                                 and the schema-cache work?
--   2.  Autocomplete probes     — exercise alias completion,
--                                 cross-schema joins, the dot-trigger.
--   3.  Tree expansion checks   — touch every relation so the
--                                 catalogue prefetch lights up.
--   4.  Performance probes      — intentionally slow queries that
--                                 benefit from the perf visualizer.
--   5.  Optimizer warm-ups      — manual `EXPLAIN ANALYZE` snippets
--                                 (the toolbar's "Run with plan"
--                                 button wraps them automatically).
--   6.  Performance scenarios   — designed to render interestingly
--                                 in the Plan / Flame views.
--   7.  Complex multi-join      — bigger plan trees / flames.
--   8.  Lock telemetry scenarios — designed for the "Run with…
--                                  ☑ Locks" button. Each scenario
--                                  acquires a different lock
--                                  granularity (row / page / table /
--                                  advisory) so the Locks sub-tab
--                                  has something interesting to
--                                  visualise.
-- ─────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────
-- 1. Smoke tests
-- ─────────────────────────────────────────────────────────────────────

-- Round-trip the connection.
SELECT 1 AS ok, current_database() AS db, current_user AS who;

-- Schemas + table counts (one row per schema). Fast — sanity check
-- that the seed completed.
SELECT n.nspname AS schema,
       count(*)  AS relation_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('shop', 'metrics')
  AND c.relkind IN ('r', 'v', 'm')
GROUP BY n.nspname
ORDER BY n.nspname;


-- ─────────────────────────────────────────────────────────────────────
-- 2. Autocomplete probes — these exercise the editor's alias
--    completion + dot-trigger logic.
-- ─────────────────────────────────────────────────────────────────────

-- Bare table — `events` lives under `metrics`, autocomplete should
-- fall back through the catalog to find it. Type `events.<col>` to
-- see column completions.
SELECT id, happened, action, duration_ms
FROM metrics.events
ORDER BY happened DESC
LIMIT 10;

-- Aliased qualified ref — `e.<col>` should resolve to the right
-- columns once the cache catches up.
SELECT e.action, e.actor, e.happened
FROM metrics.events AS e
WHERE e.action = 'purchase'
ORDER BY e.happened DESC
LIMIT 5;

-- Multi-alias join across two schemas — exercises cross-schema
-- alias resolution.
SELECT
    e.action,
    e.happened,
    c.full_name,
    c.email
FROM metrics.events e
JOIN shop.customers c ON c.id = e.customer_id
WHERE e.action = 'purchase'
ORDER BY e.happened DESC
LIMIT 20;


-- ─────────────────────────────────────────────────────────────────────
-- 3. Tree expansion / prefetch coverage — touch every relation.
-- ─────────────────────────────────────────────────────────────────────

-- shop schema sweep: customers + addresses + orders + items in one go.
SELECT
    c.full_name,
    a.line1                   AS billing_line,
    o.placed_at,
    o.status,
    o.total_cents,
    array_agg(p.name ORDER BY p.name) AS products
FROM shop.customers   c
JOIN shop.addresses   a  ON a.customer_id = c.id AND a.kind = 'billing'
JOIN shop.orders      o  ON o.customer_id = c.id
JOIN shop.order_items oi ON oi.order_id = o.id
JOIN shop.products    p  ON p.id = oi.product_id
GROUP BY c.full_name, a.line1, o.placed_at, o.status, o.total_cents
ORDER BY o.placed_at DESC
LIMIT 15;

-- Routine call — verifies the per-schema "Routines" folder also
-- works at runtime.
SELECT * FROM shop.top_customers(5);

-- Function-call form (returns a scalar).
SELECT
    c.id,
    c.full_name,
    shop.customer_lifetime_value(c.id) AS ltv_cents
FROM shop.customers c
ORDER BY ltv_cents DESC
LIMIT 5;


-- ─────────────────────────────────────────────────────────────────────
-- 4. Performance probes — intentionally non-trivial. Good targets
--    for the future "show me the plan / flamegraph" feature.
-- ─────────────────────────────────────────────────────────────────────

-- Daily aggregation — uses the events_happened_idx descending index.
-- Should be sub-second on 200k rows.
SELECT
    (happened AT TIME ZONE 'UTC')::date AS day,
    action,
    count(*)                            AS n,
    avg(duration_ms)::numeric(10,2)     AS avg_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM metrics.events
WHERE happened >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, n DESC;

-- Same query against the materialized view — should be ~instant.
SELECT *
FROM metrics.daily_event_summary
ORDER BY day DESC
LIMIT 14;

-- A deliberately *bad* query for the optimizer to chew on later:
-- correlated subquery instead of a join, no index help. Notice the
-- difference vs. the rewrite below.
SELECT c.id, c.full_name,
       (SELECT count(*) FROM shop.orders o WHERE o.customer_id = c.id) AS orders,
       (SELECT count(*) FROM metrics.events e WHERE e.customer_id = c.id) AS events
FROM shop.customers c
ORDER BY events DESC;

-- The rewrite — single GROUP BY, hits the FK index. Should be
-- noticeably faster.
SELECT c.id, c.full_name,
       count(DISTINCT o.id) AS orders,
       count(DISTINCT e.id) AS events
FROM shop.customers c
LEFT JOIN shop.orders   o ON o.customer_id = c.id
LEFT JOIN metrics.events e ON e.customer_id = c.id
GROUP BY c.id, c.full_name
ORDER BY events DESC;

-- JSONB filter — uses the GIN index on events.metadata. Stress it
-- by adding `EXPLAIN ANALYZE` in front.
SELECT count(*)
FROM metrics.events
WHERE metadata @> '{"browser":"firefox","mobile":true}';

-- Non-trivial window-function aggregation across the wide table.
SELECT
    service,
    region,
    avg(duration_ms)                        AS avg_ms,
    avg(avg(duration_ms)) OVER (PARTITION BY service) AS service_avg_ms,
    count(*)                                AS samples
FROM metrics.wide_records
WHERE recorded_at >= now() - interval '24 hours'
GROUP BY service, region
ORDER BY service, region;


-- ─────────────────────────────────────────────────────────────────────
-- 5. Optimizer warm-ups — already-formatted EXPLAIN ANALYZE so the
--    future "Plan" pane has a no-effort starting point.
-- ─────────────────────────────────────────────────────────────────────

-- Run as-is and copy the JSON output into a flamegraph viewer when
-- that lands. `(FORMAT JSON, ANALYZE, BUFFERS)` is the canonical
-- shape for downstream tooling (pgMustard, postgres-explain.com).
EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS, VERBOSE, TIMING)
SELECT actor, action, count(*) AS n
FROM metrics.events
WHERE happened >= now() - interval '24 hours'
GROUP BY actor, action
ORDER BY n DESC;

-- Same query without the index — drop it temporarily to see the
-- planner pick a seq-scan.
-- DROP INDEX metrics.events_actor_happened_idx;
-- (… run EXPLAIN above …)
-- CREATE INDEX events_actor_happened_idx ON metrics.events (actor, happened DESC);

-- Plan for the deliberately-bad correlated-subquery version above.
EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)
SELECT c.id, c.full_name,
       (SELECT count(*) FROM shop.orders o WHERE o.customer_id = c.id) AS orders
FROM shop.customers c
ORDER BY orders DESC;


-- ─────────────────────────────────────────────────────────────────────
-- Bonus: write paths to exercise triggers + audit log.
-- ─────────────────────────────────────────────────────────────────────

-- Touching `customers` fires `customers_audit` and bumps
-- `updated_at`. Re-run a few times then SELECT from audit_log to
-- see the trail.
UPDATE shop.customers
   SET phone = '+1-555-9999'
 WHERE email = 'ada@example.com';

SELECT *
FROM shop.audit_log
WHERE table_name = 'customers'
ORDER BY changed_at DESC
LIMIT 10;

-- Procedure call (Postgres syntax — note the `CALL`, not `SELECT`).
CALL shop.archive_old_orders(now() - interval '365 days');


-- ─────────────────────────────────────────────────────────────────────
-- 6. Performance scenarios — designed to be run via the toolbar's
--    "Run with plan" button. Each query has a particular plan
--    shape that the visualizer renders interestingly:
--    Raw shows the JSON / XML, Plan walks the node tree, Flame
--    gives proportional self-time per node.
--
--    Patterns to look for:
--      * `≥10× est skew` badges in Plan tab when the planner
--        misjudged cardinality
--      * `uncached I/O` badges when sharedRead > sharedHit
--      * Top-5 slow-node chips above the tree
--      * Buffer hit-ratio gauge (Postgres only) — red < 50% is
--        the I/O-bound smoke test
--      * Δ in Compare mode after a second run
-- ─────────────────────────────────────────────────────────────────────

-- Hash join vs nested-loop. Click "Run with plan" twice — once
-- as-is, then a second time after the SET to force a different
-- plan shape; the Compare dropdown shows Δ self-time.
SELECT
    c.full_name,
    count(*) AS orders,
    sum(o.total_cents) AS spent
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.id
WHERE o.placed_at >= now() - interval '90 days'
GROUP BY c.full_name
ORDER BY spent DESC NULLS LAST
LIMIT 20;
-- Then re-run after:
--   SET enable_hashjoin = off;
-- to force a merge / nested-loop join.

-- Cardinality skew probe — the WHERE drains 99% of the table but
-- the planner's selectivity histogram thinks it's narrow. Triggers
-- the `≥10× est skew` badge on the Bitmap/Index Scan node.
SELECT actor, count(*)
FROM metrics.events
WHERE happened > now() - interval '14 days'  -- ALL rows; histogram unclear
GROUP BY actor;

-- Aggregate over 200k rows. Watch the GROUP BY / Sort / HashAgg
-- distribute time in the flame view; self-time on the aggregate
-- node usually dominates.
SELECT
    (happened AT TIME ZONE 'UTC')::date AS day,
    action,
    count(*) AS n,
    avg(duration_ms)::numeric(10,2) AS avg_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM metrics.events
WHERE happened >= now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, n DESC;

-- Window function — exposes a Sort + WindowAgg path which the
-- visualizer renders as two stacked nodes in the flame view.
SELECT
    actor,
    happened,
    duration_ms,
    avg(duration_ms) OVER (
        PARTITION BY actor
        ORDER BY happened
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    ) AS rolling_avg
FROM metrics.events
WHERE happened >= now() - interval '24 hours'
ORDER BY actor, happened;

-- GIN index hit on jsonb. Bitmap Index Scan + Recheck path —
-- look for the GIN index in the Plan tab and good hit ratio in
-- the buffer panel.
SELECT count(*)
FROM metrics.events
WHERE metadata @> '{"browser":"firefox","mobile":true}';

-- Pathological seq scan — there's an `lower(email)` expression
-- index in the seed, but the predicate function-shape doesn't
-- match exactly so the planner falls back to seq scan. Useful to
-- see the "uncached I/O" badge on a small table that exercises
-- the buffer pool.
SELECT id, full_name
FROM shop.customers
WHERE position('a' in lower(email)) > 0;

-- Recursive CTE — the categories self-FK gives us a tree. The
-- visualizer's PlanTree shows the WorkTable + recursive scan
-- nodes nested.
WITH RECURSIVE tree AS (
    SELECT id, parent_id, name, slug, 0 AS depth
    FROM shop.categories
    WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, c.name, c.slug, t.depth + 1
    FROM shop.categories c
    JOIN tree t ON t.id = c.parent_id
)
SELECT depth, name, slug FROM tree ORDER BY depth, name;

-- Subplan / InitPlan — the inner SELECT shows up as a child of
-- the outer Filter node. Good for verifying nested rendering.
SELECT id, customer_id, total_cents
FROM shop.orders
WHERE total_cents > (
    SELECT avg(total_cents)::int
    FROM shop.orders
    WHERE status IN ('paid','shipped','delivered')
)
ORDER BY total_cents DESC
LIMIT 25;

-- Cross-schema join with FK lookup. Demonstrates an Index Scan
-- on the FK column (`metrics.events.customer_id`) when the
-- planner picks the events_customer_idx partial index.
SELECT c.full_name, count(*) AS event_count
FROM metrics.events e
JOIN shop.customers c ON c.id = e.customer_id
WHERE e.happened >= now() - interval '24 hours'
GROUP BY c.full_name
ORDER BY event_count DESC
LIMIT 10;


-- ─────────────────────────────────────────────────────────────────────
-- 7. Complex multi-join scenarios — bigger plan trees, more
--    interesting flame graphs. Each query is self-contained;
--    pick any and click "Run with plan" to see the shape.
-- ─────────────────────────────────────────────────────────────────────

-- Five-table chain: customers → orders → order_items → products →
-- categories (via the M:N join). Aggregates per (customer, category).
-- Renders as a stacked Hash Join tower in the flame view; the
-- aggregate node usually dominates self-time on the 200k-row event
-- side, but here it's the hash-join build over orders that wins.
SELECT
    c.full_name,
    cat.name              AS category,
    count(DISTINCT o.id)  AS order_count,
    sum(oi.quantity * oi.unit_cents) AS gross_cents,
    max(o.placed_at)      AS last_order_at
FROM shop.customers c
JOIN shop.orders            o   ON o.customer_id     = c.id
JOIN shop.order_items       oi  ON oi.order_id       = o.id
JOIN shop.products          p   ON p.id              = oi.product_id
JOIN shop.product_categories pc ON pc.product_id     = p.id
JOIN shop.categories        cat ON cat.id            = pc.category_id
WHERE o.status IN ('paid', 'shipped', 'delivered')
  AND o.placed_at >= now() - interval '180 days'
GROUP BY c.full_name, cat.name
HAVING count(DISTINCT o.id) >= 1
ORDER BY gross_cents DESC NULLS LAST
LIMIT 50;

-- Top-3 most recent orders per customer, via LATERAL. The
-- LATERAL subquery becomes a Nested Loop in the plan — one
-- inner scan per outer customer row. Compare with the
-- ROW_NUMBER() variant below to see two very different shapes
-- for the same answer.
SELECT
    c.id,
    c.full_name,
    recent.placed_at,
    recent.status,
    recent.total_cents
FROM shop.customers c
LEFT JOIN LATERAL (
    SELECT o.id, o.placed_at, o.status, o.total_cents
    FROM shop.orders o
    WHERE o.customer_id = c.id
    ORDER BY o.placed_at DESC
    LIMIT 3
) recent ON true
ORDER BY c.full_name, recent.placed_at DESC NULLS LAST;

-- Same answer via window deduplication — usually one Sort + one
-- WindowAgg at the top of the plan, then a Filter. The flame
-- view contrasts cleanly with the LATERAL version above.
WITH ranked AS (
    SELECT
        o.*,
        row_number() OVER (PARTITION BY o.customer_id
                           ORDER BY o.placed_at DESC) AS rn
    FROM shop.orders o
)
SELECT
    c.full_name,
    r.placed_at,
    r.status,
    r.total_cents
FROM shop.customers c
LEFT JOIN ranked r
       ON r.customer_id = c.id AND r.rn <= 3
ORDER BY c.full_name, r.placed_at DESC NULLS LAST;

-- GROUPING SETS — multiple roll-up levels in one query. Plan
-- shows multiple HashAggregate nodes (one per grouping) feeding
-- into a single Append. Easy way to compare aggregate shapes
-- side-by-side.
SELECT
    coalesce(o.status,                'TOTAL') AS status,
    coalesce(p.method,                'TOTAL') AS payment_method,
    count(DISTINCT o.id)                       AS orders,
    sum(o.total_cents)                         AS gross_cents
FROM shop.orders   o
LEFT JOIN shop.payments p ON p.order_id = o.id
GROUP BY GROUPING SETS (
    (o.status, p.method),
    (o.status),
    (p.method),
    ()
)
ORDER BY status, payment_method;

-- Anti-join via `NOT EXISTS`: customers who've never placed an
-- order. Planner usually picks Hash Anti Join — one of the
-- visually-distinct join nodes worth seeing.
SELECT c.id, c.full_name, c.email
FROM shop.customers c
WHERE NOT EXISTS (
    SELECT 1
    FROM shop.orders o
    WHERE o.customer_id = c.id
);

-- Same answer via LEFT JOIN + IS NULL. Can produce a different
-- physical plan than NOT EXISTS — handy for the Compare view.
SELECT c.id, c.full_name, c.email
FROM shop.customers c
LEFT JOIN shop.orders o ON o.customer_id = c.id
WHERE o.id IS NULL;

-- Self-join: orders that exceed their customer's running average.
-- The inner avg() per customer aggregates first, then a Hash
-- Join broadcasts the per-customer averages back. Three-deep
-- aggregate-then-join shape.
WITH per_customer AS (
    SELECT customer_id, avg(total_cents)::int AS avg_cents
    FROM shop.orders
    WHERE status IN ('paid', 'shipped', 'delivered')
    GROUP BY customer_id
)
SELECT
    o.id,
    o.placed_at,
    o.total_cents,
    pc.avg_cents,
    o.total_cents - pc.avg_cents AS over_avg_by
FROM shop.orders o
JOIN per_customer pc ON pc.customer_id = o.customer_id
WHERE o.total_cents > pc.avg_cents * 2
ORDER BY over_avg_by DESC NULLS LAST
LIMIT 25;

-- UNION ALL of two heterogeneous queries. Plan shows an Append
-- node combining a sales-side aggregate with a refund-side one.
-- The flame view stacks the two children of Append nicely.
SELECT 'paid'   AS bucket, date_trunc('day', placed_at) AS day,
       sum(total_cents) AS cents
FROM shop.orders
WHERE status IN ('paid', 'shipped', 'delivered')
  AND placed_at >= now() - interval '60 days'
GROUP BY 2
UNION ALL
SELECT 'refunded' AS bucket, date_trunc('day', placed_at) AS day,
       sum(total_cents) AS cents
FROM shop.orders
WHERE status = 'refunded'
  AND placed_at >= now() - interval '60 days'
GROUP BY 2
ORDER BY day, bucket;

-- Customer-cohort retention: who placed an order in each of the
-- last 12 weeks? Date series LEFT JOIN against orders + EXISTS
-- per cohort. Generates a 12 × N output where N is the active
-- customer count. The plan is large — `generate_series` →
-- multiple Hash Anti Joins, then Sort.
WITH weeks AS (
    SELECT generate_series(
        date_trunc('week', now()) - interval '11 weeks',
        date_trunc('week', now()),
        interval '1 week'
    ) AS week_start
),
active_customers AS (
    SELECT DISTINCT customer_id
    FROM shop.orders
    WHERE placed_at >= now() - interval '12 weeks'
      AND status IN ('paid', 'shipped', 'delivered')
)
SELECT
    w.week_start,
    count(*) FILTER (
        WHERE EXISTS (
            SELECT 1 FROM shop.orders o
            WHERE o.customer_id = ac.customer_id
              AND o.placed_at >= w.week_start
              AND o.placed_at <  w.week_start + interval '1 week'
              AND o.status IN ('paid', 'shipped', 'delivered')
        )
    ) AS active
FROM weeks w
CROSS JOIN active_customers ac
GROUP BY w.week_start
ORDER BY w.week_start;

-- Three-way query rewrite practice: same answer, three plans.
-- (a) Correlated subquery in SELECT — usually awful.
-- (b) JOIN + GROUP BY — typically the best.
-- (c) Lateral subquery — wins when correlated state is unavoidable.
-- Run each individually with "Run with plan" and stack them via
-- the Compare dropdown.

-- (a) correlated subquery
SELECT
    p.id,
    p.name,
    (SELECT count(*)        FROM shop.order_items oi WHERE oi.product_id = p.id) AS times_ordered,
    (SELECT sum(oi.quantity) FROM shop.order_items oi WHERE oi.product_id = p.id) AS units_sold
FROM shop.products p
ORDER BY units_sold DESC NULLS LAST;

-- (b) join + group by
SELECT
    p.id,
    p.name,
    count(*)         AS times_ordered,
    sum(oi.quantity) AS units_sold
FROM shop.products p
LEFT JOIN shop.order_items oi ON oi.product_id = p.id
GROUP BY p.id, p.name
ORDER BY units_sold DESC NULLS LAST;

-- (c) lateral aggregate
SELECT
    p.id,
    p.name,
    s.times_ordered,
    s.units_sold
FROM shop.products p
LEFT JOIN LATERAL (
    SELECT count(*) AS times_ordered, sum(oi.quantity) AS units_sold
    FROM shop.order_items oi
    WHERE oi.product_id = p.id
) s ON true
ORDER BY s.units_sold DESC NULLS LAST;

-- Cross-schema heavy join: events ↘ customers ↘ orders. Two
-- different time windows with EXISTS predicates. The planner
-- often picks a hash semi-join here; estimating customer
-- selectivity from event ↔ order activity is exactly the
-- shape that triggers `≥10× est skew` if your data is uneven.
SELECT
    c.id,
    c.full_name,
    count(DISTINCT e.id)               AS events_24h,
    sum(o.total_cents) FILTER (
        WHERE o.placed_at >= now() - interval '90 days'
    )                                  AS spent_90d_cents
FROM shop.customers c
LEFT JOIN metrics.events e
       ON e.customer_id = c.id
      AND e.happened   >= now() - interval '24 hours'
LEFT JOIN shop.orders o
       ON o.customer_id = c.id
      AND o.status      IN ('paid', 'shipped', 'delivered')
WHERE EXISTS (
    SELECT 1 FROM shop.orders o2
    WHERE o2.customer_id = c.id
      AND o2.placed_at  >= now() - interval '180 days'
)
GROUP BY c.id, c.full_name
ORDER BY spent_90d_cents DESC NULLS LAST
LIMIT 30;


-- ─────────────────────────────────────────────────────────────────────
-- 8. Lock telemetry scenarios — designed for the toolbar's
--    "Run with…" → ☑ Locks button. Each scenario is a
--    multi-statement transaction (`BEGIN; <op>; pg_sleep(.4);
--    ROLLBACK;`). The lock taken by `<op>` stays held until
--    ROLLBACK; the backend runs **one sampler across the whole
--    batch** and aggregates everything into a single summary.
--
--    **HOW TO RUN: drag-select the entire 4-line block first**,
--    then click "Run with…" → ☑ Locks. The toolbar's Run
--    button only fires the statement at the cursor — without
--    a selection you'd run just the BEGIN (no locks) or just
--    the UPDATE without the surrounding transaction (lock
--    auto-released before the sampler ticks).
--
--    With a selection, `db_query` runs all four statements as
--    one batch on the same Postgres pool connection. You get
--    **four result tabs** (one per statement), and the
--    aggregated **Locks sub-tab is on tab 0** (the `BEGIN`
--    tab) — which the UI auto-selects on Run, so the locks
--    panel is right there.
--
--    The Locks sub-tab will show:
--      • A `row` / `page` / `table` chip on the granularity bar
--      • Per-mode counts (AccessShareLock, RowExclusiveLock, …)
--      • The locked schema.table in the Objects list
--      • A timeline sparkline of locks-over-time covering the
--        entire batch from BEGIN to ROLLBACK
--
--    To demo BLOCKING locks, open a second connection in the
--    explorer and run scenario (B) there first (without the
--    ROLLBACK), then run scenario (A) here. The Locks panel
--    will show `blocked_ms > 0` and the other session's PID
--    in the Blockers list.
-- ─────────────────────────────────────────────────────────────────────

-- (A) Single-row UPDATE — looks like "many TABLE locks" but isn't.
--
--     **Postgres naming gotcha**: a single-row UPDATE shows up as
--     `TABLE` granularity with mode `RowExclusiveLock` on
--     `shop.customers` PLUS one entry per index on customers
--     (pkey, email_key, email_lower_idx, active_idx) PLUS
--     `shop.audit_log` and its sequence (cascaded by the
--     `customers_audit` trigger). All TABLE granularity. The
--     panel will surface a "Why is everything TABLE?" explainer.
--
--     The actual row-level serialization is the
--     `transactionid` lock visible under `transaction`
--     granularity — that's the lock another session would block
--     on if it tried to update the same row.
--
--     The Objects list visually de-emphasizes indexes /
--     sequences / audit-cascade rows so your eye lands on
--     `shop.customers` first.
BEGIN;
UPDATE shop.customers SET phone = phone WHERE id = 1;
SELECT pg_sleep(0.4);  -- park so the sampler catches the held locks
ROLLBACK;

-- (B) Explicit row lock via SELECT ... FOR UPDATE.
--     Expect: `transaction` (xid lock) + `RowShareLock` on the
--     relation (TABLE granularity, despite the name) + a brief
--     `tuple` (row granularity) that may or may not be sampled
--     depending on timing. The classic queue / job dispatcher
--     pattern. The xid lock is what other sessions queue on.
BEGIN;
SELECT id, full_name FROM shop.customers WHERE id = 1 FOR UPDATE;
SELECT pg_sleep(0.4);
ROLLBACK;

-- (C) Many-row UPDATE — same pattern as (A), bigger blast radius.
--     Expect: TABLE / RowExclusiveLock on `shop.orders` and
--     every index on it. The `transaction` lock is one xid
--     covering all the rows touched (Postgres serializes by xid,
--     not per-row). For visible per-row locks you'd need
--     `tuple` granularity to be sampled — which usually only
--     fires on contention, not on uncontended bulk writes.
BEGIN;
UPDATE shop.orders SET status = status WHERE placed_at >= now() - interval '30 days';
SELECT pg_sleep(0.4);
ROLLBACK;

-- (D) Whole-table exclusive lock (LOCK TABLE).
--     Expect: a single `table` granularity hit with mode
--     `AccessExclusiveLock` on `shop.products` — the most
--     restrictive lock in Postgres. **Only DDL on a busy
--     table reaches this; here it's explicit for the demo.**
BEGIN;
LOCK TABLE shop.products IN ACCESS EXCLUSIVE MODE;
SELECT pg_sleep(0.4);
ROLLBACK;

-- (E) Advisory lock — application-level coordination, not a
--     row/page/table lock. Useful when you need cross-session
--     coordination outside the relational lock graph (e.g.
--     "only one worker may run this job at a time").
--     Expect: `advisory` granularity, mode `ExclusiveLock`,
--     no object name (advisory locks aren't tied to a relation).
BEGIN;
SELECT pg_advisory_xact_lock(42);
SELECT pg_sleep(0.4);
ROLLBACK;

-- (F) Shared SELECT — the "no interesting locks" baseline.
--     Expect: only the implicit per-connection database lock
--     plus an `AccessShareLock` on `metrics.events` for the
--     duration of the read. The Locks panel will show the
--     "this is background noise" banner if you don't include
--     the join. Use this to confirm sampling actually works
--     when there's nothing exciting to find.
SELECT count(*) FROM metrics.events WHERE happened >= now() - interval '1 hour';

-- (G) DDL on a hot table — combine "Plan + Locks" from the
--     dropdown to see the same statement render an
--     AccessExclusiveLock in the Locks tab AND a flat plan
--     tree in the Plan tab. Idempotent: re-running rebuilds
--     the index.
BEGIN;
CREATE INDEX IF NOT EXISTS demo_events_actor_idx ON metrics.events (actor);
SELECT pg_sleep(0.2);
DROP INDEX IF EXISTS metrics.demo_events_actor_idx;
ROLLBACK;

