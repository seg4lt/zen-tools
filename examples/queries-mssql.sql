-- ─────────────────────────────────────────────────────────────────────
-- Copy-paste sample queries — **MSSQL / T-SQL dialect**.
--
-- Targets the seed in `docker/mssql/01-init.sql`. The Postgres
-- counterpart lives in `examples/queries-postgres.sql`. Where the
-- two dialects diverge, this file uses T-SQL idioms:
--
--   - `TOP N` instead of `LIMIT N`
--   - `DATEADD(DAY, -7, SYSUTCDATETIME())` instead of
--     `now() - interval '7 days'`
--   - `STRING_AGG` instead of `array_agg`
--   - `CHARINDEX` / `LIKE` instead of `position()`
--   - `EXEC <proc>` instead of `CALL <proc>`
--   - `SET STATISTICS XML ON;` for plans (the toolbar "Run with
--     plan" button wraps this automatically)
--
-- Open this file in the SQL editor, place the cursor on any
-- statement, hit Cmd+Enter. Click "Run with plan" on section-6
-- queries to open the perf visualizer.
-- ─────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────
-- 1. Smoke tests
-- ─────────────────────────────────────────────────────────────────────

-- Round-trip the connection.
SELECT 1 AS ok, DB_NAME() AS db, SUSER_SNAME() AS who;

-- Schemas + table counts (one row per schema). Sanity check that
-- the seed completed.
SELECT s.name AS [schema],
       COUNT(*)  AS relation_count
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name IN ('shop', 'metrics')
  AND o.type IN ('U', 'V')   -- user table, view
GROUP BY s.name
ORDER BY s.name;


-- ─────────────────────────────────────────────────────────────────────
-- 2. Autocomplete probes — exercise alias resolution + dot-trigger.
-- ─────────────────────────────────────────────────────────────────────

-- Bare table — `events` lives under `metrics`. Type `events.<col>`
-- to see column completions.
SELECT TOP 10 id, happened, action, duration_ms
FROM metrics.events
ORDER BY happened DESC;

-- Aliased qualified ref — `e.<col>` should resolve to events.
SELECT TOP 5 e.action, e.actor, e.happened
FROM metrics.events AS e
WHERE e.action = 'purchase'
ORDER BY e.happened DESC;

-- Multi-alias join across two schemas.
SELECT TOP 20
    e.action,
    e.happened,
    c.full_name,
    c.email
FROM metrics.events e
JOIN shop.customers c ON c.id = e.customer_id
WHERE e.action = 'purchase'
ORDER BY e.happened DESC;


-- ─────────────────────────────────────────────────────────────────────
-- 3. Tree expansion / prefetch coverage — touch every relation.
-- ─────────────────────────────────────────────────────────────────────

-- shop schema sweep: customers + addresses + orders + items in one
-- go. T-SQL doesn't have `array_agg` so we collapse product names
-- with `STRING_AGG` (SQL Server 2017+).
SELECT TOP 15
    c.full_name,
    a.line1                   AS billing_line,
    o.placed_at,
    o.status,
    o.total_cents,
    STRING_AGG(p.name, ', ') WITHIN GROUP (ORDER BY p.name) AS products
FROM shop.customers   c
JOIN shop.addresses   a  ON a.customer_id = c.id AND a.kind = 'billing'
JOIN shop.orders      o  ON o.customer_id = c.id
JOIN shop.order_items oi ON oi.order_id = o.id
JOIN shop.products    p  ON p.id = oi.product_id
GROUP BY c.full_name, a.line1, o.placed_at, o.status, o.total_cents
ORDER BY o.placed_at DESC;

-- Routine call — exercises the per-schema "Routines" folder.
-- `order_summary` is an inline TVF so it works as a table source.
SELECT * FROM shop.order_summary(DATEADD(DAY, -30, SYSUTCDATETIME()));

-- Function-call form (returns a scalar). `customer_lifetime_value`
-- is a scalar UDF; T-SQL forces the schema-qualified call.
SELECT TOP 5
    c.id,
    c.full_name,
    shop.customer_lifetime_value(c.id) AS ltv_cents
FROM shop.customers c
ORDER BY ltv_cents DESC;


-- ─────────────────────────────────────────────────────────────────────
-- 4. Performance probes — non-trivial queries for the visualizer.
-- ─────────────────────────────────────────────────────────────────────

-- Daily aggregation — `CAST(happened AS DATE)` for the day bucket
-- (T-SQL has no `AT TIME ZONE 'UTC'::date` shape). Should be
-- sub-second on 200k rows thanks to events_happened_idx.
SELECT
    CAST(happened AS DATE) AS day,
    action,
    COUNT(*) AS n,
    AVG(CAST(duration_ms AS DECIMAL(10,2))) AS avg_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
        OVER (PARTITION BY CAST(happened AS DATE), action) AS p95_ms
FROM metrics.events
WHERE happened >= DATEADD(DAY, -7, SYSUTCDATETIME())
GROUP BY CAST(happened AS DATE), action, duration_ms
ORDER BY day DESC, n DESC;

-- A deliberately *bad* query for the optimizer to chew on:
-- correlated subqueries instead of a join, no index help.
SELECT c.id, c.full_name,
       (SELECT COUNT(*) FROM shop.orders o WHERE o.customer_id = c.id) AS orders_n,
       (SELECT COUNT(*) FROM metrics.events e WHERE e.customer_id = c.id) AS events_n
FROM shop.customers c
ORDER BY events_n DESC;

-- The rewrite — single GROUP BY, hits the FK indexes. Faster.
SELECT c.id, c.full_name,
       COUNT(DISTINCT o.id) AS orders_n,
       COUNT(DISTINCT e.id) AS events_n
FROM shop.customers c
LEFT JOIN shop.orders o   ON o.customer_id = c.id
LEFT JOIN metrics.events e ON e.customer_id = c.id
GROUP BY c.id, c.full_name
ORDER BY events_n DESC;

-- Window-function aggregation. Exercises both an inner per-region
-- aggregate and an outer per-service window — the flame view shows
-- two stacked aggregate nodes.
SELECT
    service,
    region,
    AVG(CAST(duration_ms AS FLOAT))                                AS avg_ms,
    AVG(AVG(CAST(duration_ms AS FLOAT))) OVER (PARTITION BY service) AS service_avg_ms,
    COUNT(*)                                                       AS samples
FROM metrics.wide_records
WHERE recorded_at >= DATEADD(HOUR, -24, SYSUTCDATETIME())
GROUP BY service, region
ORDER BY service, region;


-- ─────────────────────────────────────────────────────────────────────
-- 5. Optimizer warm-ups — manual STATISTICS XML wrappers.
--    The toolbar's "Run with plan" button does this for you.
-- ─────────────────────────────────────────────────────────────────────

-- Capture an actual-execution plan for one query. Run all three
-- statements together (Run all): the second result set is the
-- ShowPlanXML row the visualizer parses.
SET STATISTICS XML ON;
SELECT actor, action, COUNT(*) AS n
FROM metrics.events
WHERE happened >= DATEADD(DAY, -1, SYSUTCDATETIME())
GROUP BY actor, action
ORDER BY n DESC;
SET STATISTICS XML OFF;

-- Estimated-only plan (no execution) — useful for what-if checks.
-- Surfaces in the visualizer with no `actual rows` numbers.
SET SHOWPLAN_XML ON;
SELECT c.id, c.full_name,
       (SELECT COUNT(*) FROM shop.orders o WHERE o.customer_id = c.id) AS orders
FROM shop.customers c
ORDER BY orders DESC;
SET SHOWPLAN_XML OFF;


-- ─────────────────────────────────────────────────────────────────────
-- Bonus: write paths to exercise triggers + audit log.
-- ─────────────────────────────────────────────────────────────────────

-- Touching `customers` fires the `customers_audit` AFTER trigger
-- and bumps `updated_at`. Re-run a few times then SELECT from
-- audit_log to see the trail.
UPDATE shop.customers
   SET phone = '+1-555-9999'
 WHERE email = 'ada@example.com';

SELECT TOP 10 *
FROM shop.audit_log
WHERE table_name = 'customers'
ORDER BY changed_at DESC;

-- Procedure call (T-SQL syntax — `EXEC`, not `CALL`).
EXEC shop.archive_old_orders @cutoff = '2020-01-01';


-- ─────────────────────────────────────────────────────────────────────
-- 6. Performance scenarios — designed for the toolbar's
--    "Run with plan" button. Each query has a particular plan
--    shape that the visualizer renders interestingly.
--
--    Patterns to look for:
--      * `≥10× est skew` badges in Plan tab when the planner
--        misjudged cardinality
--      * Top-5 slow-node chips above the tree
--      * Δ in Compare mode after a second run with hints flipped
--
--    Note: MSSQL's ShowPlanXML doesn't carry per-node actual-time,
--    so the flame view falls back to "by cost" sizing — clearly
--    labelled in the header chip.
-- ─────────────────────────────────────────────────────────────────────

-- Hash join vs nested-loop. Click "Run with plan" twice — the
-- second time append the OPTION hint to force the alternate
-- shape; Compare dropdown shows the Δ.
SELECT TOP 20
    c.full_name,
    COUNT(*)            AS orders,
    SUM(o.total_cents)  AS spent
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.id
WHERE o.placed_at >= DATEADD(DAY, -90, SYSUTCDATETIME())
GROUP BY c.full_name
ORDER BY spent DESC;
-- Then re-run with:
--   OPTION (LOOP JOIN)   -- forces nested-loop shape
-- or
--   OPTION (HASH JOIN)   -- forces hash join
-- appended at the end of the SELECT (before the trailing `;`).

-- Cardinality-skew probe — predicate selects nearly the whole
-- table but the histogram thinks it's narrow. Trips `≥10× est skew`.
SELECT actor, COUNT(*) AS n
FROM metrics.events
WHERE happened > DATEADD(DAY, -14, SYSUTCDATETIME())
GROUP BY actor;

-- Aggregate over 200k rows. Watch GROUP BY / Sort / Aggregate
-- distribute time across the plan tree.
SELECT
    CAST(happened AS DATE) AS day,
    action,
    COUNT(*) AS n,
    AVG(CAST(duration_ms AS DECIMAL(10,2))) AS avg_ms
FROM metrics.events
WHERE happened >= DATEADD(DAY, -7, SYSUTCDATETIME())
GROUP BY CAST(happened AS DATE), action
ORDER BY day DESC, n DESC;

-- Window function — Sort + Window Aggregate path. Two stacked
-- nodes in the flame view.
SELECT TOP 1000
    actor,
    happened,
    duration_ms,
    AVG(CAST(duration_ms AS FLOAT)) OVER (
        PARTITION BY actor
        ORDER BY happened
        ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
    ) AS rolling_avg
FROM metrics.events
WHERE happened >= DATEADD(HOUR, -24, SYSUTCDATETIME())
ORDER BY actor, happened;

-- Pathological scan. The lower(email) expression has no matching
-- expression index in the MSSQL seed, so this runs as a full
-- table scan. Useful for "uncached I/O" comparison work.
SELECT id, full_name
FROM shop.customers
WHERE CHARINDEX('a', LOWER(email)) > 0;

-- Recursive CTE — categories form a tree via `parent_id`. The
-- visualizer renders the recursion as a Compute Scalar +
-- Concatenation (UNION ALL) shape.  Note: T-SQL doesn't use the
-- `RECURSIVE` keyword; the planner infers from the self-reference.
WITH tree AS (
    SELECT id, parent_id, name, slug, 0 AS depth
    FROM shop.categories
    WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, c.name, c.slug, t.depth + 1
    FROM shop.categories c
    JOIN tree t ON t.id = c.parent_id
)
SELECT depth, name, slug FROM tree ORDER BY depth, name;

-- Subquery in WHERE — inner subquery on the same table, outer
-- Filter feeds an Index Scan. Compare with the rewrite using a
-- CTE if you want.
SELECT TOP 25 id, customer_id, total_cents
FROM shop.orders
WHERE total_cents > (
    SELECT AVG(CAST(total_cents AS BIGINT))
    FROM shop.orders
    WHERE status IN ('paid','shipped','delivered')
)
ORDER BY total_cents DESC;

-- Cross-schema join with FK lookup. Index seek on
-- `metrics.events.customer_id` thanks to events_customer_idx.
SELECT TOP 10
    c.full_name,
    COUNT(*) AS event_count
FROM metrics.events e
JOIN shop.customers c ON c.id = e.customer_id
WHERE e.happened >= DATEADD(HOUR, -24, SYSUTCDATETIME())
GROUP BY c.full_name
ORDER BY event_count DESC;


-- ─────────────────────────────────────────────────────────────────────
-- 7. Complex multi-join scenarios — bigger plan trees, more
--    interesting flame graphs. Each query is self-contained;
--    pick any and click "Run with plan" to see the shape.
--
--    Notes:
--      * `OPTION (LOOP JOIN)` / `OPTION (HASH JOIN)` /
--        `OPTION (MERGE JOIN)` query hints flip the join shape so
--        you can compare alternative plans via the Compare dropdown.
--      * `CROSS APPLY` / `OUTER APPLY` are T-SQL's LATERAL.
-- ─────────────────────────────────────────────────────────────────────

-- Five-table chain: customers → orders → order_items → products →
-- categories (via the M:N join). Aggregates per (customer, category).
-- Renders as a stacked Hash Join tower in the flame view; SQL
-- Server tends to pick Hash Match for the upper levels and
-- Nested Loops near the leaves.
SELECT TOP 50
    c.full_name,
    cat.name              AS category,
    COUNT(DISTINCT o.id)  AS order_count,
    SUM(oi.quantity * oi.unit_cents) AS gross_cents,
    MAX(o.placed_at)      AS last_order_at
FROM shop.customers c
JOIN shop.orders            o   ON o.customer_id     = c.id
JOIN shop.order_items       oi  ON oi.order_id       = o.id
JOIN shop.products          p   ON p.id              = oi.product_id
JOIN shop.product_categories pc ON pc.product_id     = p.id
JOIN shop.categories        cat ON cat.id            = pc.category_id
WHERE o.status IN ('paid', 'shipped', 'delivered')
  AND o.placed_at >= DATEADD(DAY, -180, SYSUTCDATETIME())
GROUP BY c.full_name, cat.name
HAVING COUNT(DISTINCT o.id) >= 1
ORDER BY gross_cents DESC;

-- Top-3 most recent orders per customer via CROSS APPLY (T-SQL's
-- LATERAL). The APPLY becomes a Nested Loop in the plan — one
-- inner scan per outer customer row.
SELECT
    c.id,
    c.full_name,
    recent.placed_at,
    recent.status,
    recent.total_cents
FROM shop.customers c
OUTER APPLY (
    SELECT TOP 3 o.id, o.placed_at, o.status, o.total_cents
    FROM shop.orders o
    WHERE o.customer_id = c.id
    ORDER BY o.placed_at DESC
) recent
ORDER BY c.full_name, recent.placed_at DESC;

-- Same answer via window deduplication — Sort + Sequence Project
-- (Compute Scalar) + Filter shape. Compare with the APPLY version
-- above to see how MSSQL costs the alternatives.
WITH ranked AS (
    SELECT
        o.*,
        ROW_NUMBER() OVER (PARTITION BY o.customer_id
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
ORDER BY c.full_name, r.placed_at DESC;

-- GROUPING SETS — multiple roll-up levels in one query. SQL
-- Server compiles this into multiple Stream Aggregate / Hash
-- Match (Aggregate) nodes feeding a Concatenation. Easy way
-- to compare aggregate shapes side-by-side.
SELECT
    COALESCE(o.status,  'TOTAL') AS status,
    COALESCE(p.method,  'TOTAL') AS payment_method,
    COUNT(DISTINCT o.id)         AS orders,
    SUM(o.total_cents)           AS gross_cents
FROM shop.orders   o
LEFT JOIN shop.payments p ON p.order_id = o.id
GROUP BY GROUPING SETS (
    (o.status, p.method),
    (o.status),
    (p.method),
    ()
)
ORDER BY status, payment_method;

-- Anti-join via NOT EXISTS — customers who've never placed an
-- order. SQL Server commonly picks a Left Anti Semi Join here.
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

-- Self-join: orders that exceed twice their customer's running
-- average. Inner aggregate-then-join shape — Hash Match
-- (Aggregate) feeds another Hash Match (Inner Join).
WITH per_customer AS (
    SELECT customer_id,
           CAST(AVG(CAST(total_cents AS BIGINT)) AS INT) AS avg_cents
    FROM shop.orders
    WHERE status IN ('paid', 'shipped', 'delivered')
    GROUP BY customer_id
)
SELECT TOP 25
    o.id,
    o.placed_at,
    o.total_cents,
    pc.avg_cents,
    o.total_cents - pc.avg_cents AS over_avg_by
FROM shop.orders o
JOIN per_customer pc ON pc.customer_id = o.customer_id
WHERE o.total_cents > pc.avg_cents * 2
ORDER BY over_avg_by DESC;

-- UNION ALL of two heterogeneous queries — Concatenation node
-- combines a sales-side aggregate with a refund-side one.
SELECT 'paid'   AS bucket,
       CAST(placed_at AS DATE) AS day,
       SUM(total_cents)        AS cents
FROM shop.orders
WHERE status IN ('paid', 'shipped', 'delivered')
  AND placed_at >= DATEADD(DAY, -60, SYSUTCDATETIME())
GROUP BY CAST(placed_at AS DATE)
UNION ALL
SELECT 'refunded' AS bucket,
       CAST(placed_at AS DATE) AS day,
       SUM(total_cents)        AS cents
FROM shop.orders
WHERE status = 'refunded'
  AND placed_at >= DATEADD(DAY, -60, SYSUTCDATETIME())
GROUP BY CAST(placed_at AS DATE)
ORDER BY day, bucket;

-- Customer-cohort retention over 12 weeks. T-SQL doesn't have
-- generate_series, so we synthesise the date series with a
-- recursive CTE. Heavy plan: Constant Scan → recursive Index
-- Spool, then a CROSS JOIN against active customers, then
-- Hash Anti Joins per cohort.
WITH weeks AS (
    SELECT CAST(DATEADD(DAY, -7 * 11, CAST(SYSUTCDATETIME() AS DATE)) AS DATE) AS week_start
    UNION ALL
    SELECT DATEADD(DAY, 7, week_start)
    FROM weeks
    WHERE week_start < CAST(SYSUTCDATETIME() AS DATE)
),
active_customers AS (
    SELECT DISTINCT customer_id
    FROM shop.orders
    WHERE placed_at >= DATEADD(DAY, -84, SYSUTCDATETIME())
      AND status IN ('paid', 'shipped', 'delivered')
)
SELECT
    w.week_start,
    SUM(CASE
        WHEN EXISTS (
            SELECT 1 FROM shop.orders o
            WHERE o.customer_id = ac.customer_id
              AND o.placed_at >= w.week_start
              AND o.placed_at <  DATEADD(DAY, 7, w.week_start)
              AND o.status IN ('paid', 'shipped', 'delivered')
        ) THEN 1 ELSE 0
    END) AS active
FROM weeks w
CROSS JOIN active_customers ac
GROUP BY w.week_start
ORDER BY w.week_start
OPTION (MAXRECURSION 50);

-- Three-way rewrite practice: same answer, three plans.
-- (a) Correlated subquery in SELECT — usually awful.
-- (b) JOIN + GROUP BY — typically the best.
-- (c) Lateral aggregate via OUTER APPLY — wins when correlated
--     state is unavoidable.
-- Run each individually with "Run with plan" and stack them via
-- the Compare dropdown.

-- (a) correlated subquery
SELECT
    p.id,
    p.name,
    (SELECT COUNT(*)         FROM shop.order_items oi WHERE oi.product_id = p.id) AS times_ordered,
    (SELECT SUM(oi.quantity) FROM shop.order_items oi WHERE oi.product_id = p.id) AS units_sold
FROM shop.products p
ORDER BY units_sold DESC;

-- (b) join + group by
SELECT
    p.id,
    p.name,
    COUNT(*)         AS times_ordered,
    SUM(oi.quantity) AS units_sold
FROM shop.products p
LEFT JOIN shop.order_items oi ON oi.product_id = p.id
GROUP BY p.id, p.name
ORDER BY units_sold DESC;

-- (c) lateral aggregate via OUTER APPLY
SELECT
    p.id,
    p.name,
    s.times_ordered,
    s.units_sold
FROM shop.products p
OUTER APPLY (
    SELECT COUNT(*) AS times_ordered, SUM(oi.quantity) AS units_sold
    FROM shop.order_items oi
    WHERE oi.product_id = p.id
) s
ORDER BY s.units_sold DESC;

-- Cross-schema heavy join: events ↘ customers ↘ orders. Two
-- different time windows with conditional aggregation. Hash
-- Joins on both sides; the planner's customer-selectivity
-- estimate is exactly the shape that triggers `≥10× est skew`
-- on uneven data.
SELECT TOP 30
    c.id,
    c.full_name,
    COUNT(DISTINCT e.id)                          AS events_24h,
    SUM(CASE WHEN o.placed_at >= DATEADD(DAY, -90, SYSUTCDATETIME())
             THEN o.total_cents ELSE 0 END)       AS spent_90d_cents
FROM shop.customers c
LEFT JOIN metrics.events e
       ON e.customer_id = c.id
      AND e.happened   >= DATEADD(HOUR, -24, SYSUTCDATETIME())
LEFT JOIN shop.orders o
       ON o.customer_id = c.id
      AND o.status      IN ('paid', 'shipped', 'delivered')
WHERE EXISTS (
    SELECT 1 FROM shop.orders o2
    WHERE o2.customer_id = c.id
      AND o2.placed_at  >= DATEADD(DAY, -180, SYSUTCDATETIME())
)
GROUP BY c.id, c.full_name
ORDER BY spent_90d_cents DESC;
