-- ─────────────────────────────────────────────────────────────────────
-- Copy-paste sample queries for the Database Explorer demo schemas.
--
-- Targets the seeds in `docker/postgres/01-init.sql` (and the
-- equivalent MSSQL seed). Open this file in the SQL editor, place
-- the cursor on any statement, hit Cmd+Enter (or click Run).
--
-- Use cases the queries cover:
--   1.  Smoke tests             — does the connection, the editor,
--                                 and the schema-cache work?
--   2.  Autocomplete probes     — exercise alias completion,
--                                 cross-schema joins, the dot-trigger.
--   3.  Tree expansion checks   — touch every relation so the
--                                 catalogue prefetch lights up.
--   4.  Performance probes      — intentionally slow queries that
--                                 will benefit from a future query
--                                 optimizer / flamegraph view.
--   5.  Optimizer warm-ups      — `EXPLAIN ANALYZE` snippets ready
--                                 to wire into a future "Plan" pane.
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
