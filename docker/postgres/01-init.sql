-- Seed schema + data for the Database Explorer demo.
-- Runs once on first container start (postgres image's standard
-- /docker-entrypoint-initdb.d/ hook). Re-running `docker compose up`
-- does not re-execute this file unless the pg_data volume is wiped.
-- To re-seed:
--     docker compose down -v && docker compose up
--
-- The schema is deliberately rich: lots of FKs, multi-column and
-- partial indexes, CHECKs, audit triggers, and a couple of
-- functions/procedures. That gives the DataGrip-style tree
-- expansion every kind of metadata to show, and a big enough events
-- table (200k rows) to feel the schema-cache prefetch in real time.

-- Required for gen_random_uuid() in the wide_records seed below. The
-- standard alpine image ships with this extension preinstalled.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────
-- Shared trigger functions (referenced by per-table triggers below).
-- ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS shop;

-- updated_at bumper, attached as a BEFORE UPDATE trigger to every
-- table that carries a mutable `updated_at` column.
CREATE OR REPLACE FUNCTION shop.tg_set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Generic audit trigger — appends one row per INSERT/UPDATE/DELETE
-- to shop.audit_log. Keyed off the row's `id` column when present;
-- the trigger is wired only to tables that have one.
CREATE OR REPLACE FUNCTION shop.tg_audit()
RETURNS trigger AS $$
BEGIN
    INSERT INTO shop.audit_log (table_name, op, row_pk, changed_by)
    VALUES (
        TG_TABLE_NAME,
        TG_OP,
        COALESCE((NEW).id::text, (OLD).id::text, ''),
        current_user
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────
-- shop schema — small e-commerce slice
-- ────────────────────────────────────────────────────────────────────

-- Append-only audit ledger. Defined first so triggers below can
-- reference it.
CREATE TABLE shop.audit_log (
    id          bigserial PRIMARY KEY,
    table_name  text        NOT NULL,
    op          text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
    row_pk      text        NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_by  text
);
CREATE INDEX audit_log_table_changed_idx
    ON shop.audit_log (table_name, changed_at DESC);
CREATE INDEX audit_log_changed_by_idx
    ON shop.audit_log (changed_by, changed_at DESC)
    WHERE changed_by IS NOT NULL;

CREATE TABLE shop.customers (
    id          serial PRIMARY KEY,
    email       text        NOT NULL UNIQUE,
    full_name   text        NOT NULL CHECK (length(full_name) > 0),
    phone       text,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Lower-cased email lookup for case-insensitive search.
CREATE UNIQUE INDEX customers_email_lower_idx
    ON shop.customers (lower(email));
-- Partial index — only active customers, much smaller than the full
-- table once `is_active` skews mostly false in production.
CREATE INDEX customers_active_idx
    ON shop.customers (created_at DESC)
    WHERE is_active;
CREATE TRIGGER customers_set_updated_at
    BEFORE UPDATE ON shop.customers
    FOR EACH ROW EXECUTE FUNCTION shop.tg_set_updated_at();
CREATE TRIGGER customers_audit
    AFTER INSERT OR UPDATE OR DELETE ON shop.customers
    FOR EACH ROW EXECUTE FUNCTION shop.tg_audit();

-- Self-referencing taxonomy. `parent_id` lets a category nest under
-- another (e.g. Electronics > Audio > Headphones).
CREATE TABLE shop.categories (
    id          serial PRIMARY KEY,
    parent_id   integer REFERENCES shop.categories (id) ON DELETE SET NULL,
    name        text        NOT NULL CHECK (length(name) > 0),
    slug        text        NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_parent_idx ON shop.categories (parent_id);
CREATE TRIGGER categories_set_updated_at
    BEFORE UPDATE ON shop.categories
    FOR EACH ROW EXECUTE FUNCTION shop.tg_set_updated_at();

CREATE TABLE shop.products (
    id          serial PRIMARY KEY,
    sku         text        NOT NULL UNIQUE,
    name        text        NOT NULL CHECK (length(name) > 0),
    price_cents integer     NOT NULL CHECK (price_cents >= 0),
    in_stock    boolean     NOT NULL DEFAULT true,
    weight_g    integer     CHECK (weight_g IS NULL OR weight_g > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Partial index — only in-stock rows, used by every "Browse"
-- listing.
CREATE INDEX products_in_stock_price_idx
    ON shop.products (price_cents)
    WHERE in_stock;
-- Trigram-style prefix search; cheap btree on lower(name).
CREATE INDEX products_name_lower_idx
    ON shop.products (lower(name));
CREATE TRIGGER products_set_updated_at
    BEFORE UPDATE ON shop.products
    FOR EACH ROW EXECUTE FUNCTION shop.tg_set_updated_at();

-- M:N join.
CREATE TABLE shop.product_categories (
    product_id  integer NOT NULL REFERENCES shop.products   (id) ON DELETE CASCADE,
    category_id integer NOT NULL REFERENCES shop.categories (id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);
-- Reverse-lookup index — given a category, list its products.
CREATE INDEX product_categories_category_idx
    ON shop.product_categories (category_id);

-- One customer can have many addresses; only one of each kind can
-- be `is_default`, enforced by a partial unique index.
CREATE TABLE shop.addresses (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES shop.customers (id) ON DELETE CASCADE,
    kind        text    NOT NULL CHECK (kind IN ('billing','shipping')),
    line1       text    NOT NULL,
    line2       text,
    city        text    NOT NULL,
    postcode    text    NOT NULL,
    country     text    NOT NULL DEFAULT 'US' CHECK (length(country) = 2),
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_customer_idx ON shop.addresses (customer_id);
-- Partial unique — at most one default per (customer, kind).
CREATE UNIQUE INDEX addresses_default_per_kind_idx
    ON shop.addresses (customer_id, kind)
    WHERE is_default;

CREATE TABLE shop.orders (
    id              serial PRIMARY KEY,
    customer_id     integer     NOT NULL REFERENCES shop.customers (id),
    billing_addr_id integer     REFERENCES shop.addresses (id) ON DELETE SET NULL,
    shipping_addr_id integer    REFERENCES shop.addresses (id) ON DELETE SET NULL,
    placed_at       timestamptz NOT NULL DEFAULT now(),
    total_cents     integer     NOT NULL CHECK (total_cents >= 0),
    status          text        NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Per-customer history page hits this every time.
CREATE INDEX orders_customer_placed_idx
    ON shop.orders (customer_id, placed_at DESC);
-- Status-based admin views.
CREATE INDEX orders_status_placed_idx
    ON shop.orders (status, placed_at DESC);
-- Partial index — only "live" orders, the ones that need fulfilment.
CREATE INDEX orders_live_idx
    ON shop.orders (placed_at DESC)
    WHERE status IN ('pending','paid','shipped');
CREATE TRIGGER orders_set_updated_at
    BEFORE UPDATE ON shop.orders
    FOR EACH ROW EXECUTE FUNCTION shop.tg_set_updated_at();
CREATE TRIGGER orders_audit
    AFTER INSERT OR UPDATE OR DELETE ON shop.orders
    FOR EACH ROW EXECUTE FUNCTION shop.tg_audit();

CREATE TABLE shop.order_items (
    order_id    integer NOT NULL REFERENCES shop.orders   (id) ON DELETE CASCADE,
    product_id  integer NOT NULL REFERENCES shop.products (id),
    quantity    integer NOT NULL CHECK (quantity > 0),
    unit_cents  integer NOT NULL CHECK (unit_cents >= 0),
    PRIMARY KEY (order_id, product_id)
);
-- Reverse-lookup — sales by product.
CREATE INDEX order_items_product_idx
    ON shop.order_items (product_id);

-- Shipments (one order can ship in multiple parcels). Composite
-- carrier+tracking unique constraint.
CREATE TABLE shop.shipments (
    id              serial PRIMARY KEY,
    order_id        integer NOT NULL REFERENCES shop.orders (id) ON DELETE CASCADE,
    carrier         text    NOT NULL CHECK (carrier IN ('ups','fedex','dhl','usps')),
    tracking_number text    NOT NULL,
    shipped_at      timestamptz,
    delivered_at    timestamptz,
    CONSTRAINT shipments_carrier_tracking_unique UNIQUE (carrier, tracking_number),
    CONSTRAINT shipments_delivery_after_ship_check
        CHECK (delivered_at IS NULL OR shipped_at IS NULL OR delivered_at >= shipped_at)
);
CREATE INDEX shipments_order_idx ON shop.shipments (order_id);
CREATE INDEX shipments_pending_idx
    ON shop.shipments (shipped_at)
    WHERE delivered_at IS NULL;

-- Payments — one or more per order (split-pay, partial refunds…).
CREATE TABLE shop.payments (
    id          bigserial PRIMARY KEY,
    order_id    integer     NOT NULL REFERENCES shop.orders (id) ON DELETE CASCADE,
    method      text        NOT NULL CHECK (method IN ('card','paypal','bank','gift_card','crypto')),
    amount_cents integer    NOT NULL CHECK (amount_cents > 0),
    captured_at timestamptz NOT NULL DEFAULT now(),
    refunded    boolean     NOT NULL DEFAULT false,
    notes       text
);
CREATE INDEX payments_order_idx ON shop.payments (order_id);
CREATE INDEX payments_method_captured_idx
    ON shop.payments (method, captured_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- shop functions + procedures (drives the per-schema "Routines"
-- folder in the tree).
-- ────────────────────────────────────────────────────────────────────

-- Lifetime spend (paid + shipped + delivered orders) for one customer.
CREATE OR REPLACE FUNCTION shop.customer_lifetime_value(p_customer integer)
RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(total_cents), 0)::bigint
    FROM shop.orders
    WHERE customer_id = p_customer
      AND status IN ('paid','shipped','delivered');
$$;

-- Returns the top N customers by lifetime spend.
CREATE OR REPLACE FUNCTION shop.top_customers(p_limit integer DEFAULT 10)
RETURNS TABLE (customer_id integer, full_name text, total_cents bigint)
LANGUAGE sql STABLE AS $$
    SELECT c.id, c.full_name,
           COALESCE(SUM(o.total_cents), 0)::bigint AS total_cents
    FROM shop.customers c
    LEFT JOIN shop.orders o
      ON o.customer_id = c.id
     AND o.status IN ('paid','shipped','delivered')
    GROUP BY c.id, c.full_name
    ORDER BY total_cents DESC
    LIMIT p_limit;
$$;

-- Procedure (Postgres `CALL`) — soft-archives cancelled orders older
-- than the cutoff by deleting them; demonstrates a `procedure` (vs
-- a function) under the Routines folder.
CREATE OR REPLACE PROCEDURE shop.archive_old_orders(p_cutoff timestamptz)
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM shop.orders
     WHERE placed_at < p_cutoff
       AND status = 'cancelled';
END;
$$;

-- Bulk price update — also a procedure, so the Routines folder
-- shows two procedures side by side. Returns nothing; the audit
-- trigger on shop.orders fires for each touched row through the
-- updated_at trigger chain.
CREATE OR REPLACE PROCEDURE shop.bump_prices(p_pct numeric)
LANGUAGE plpgsql AS $$
BEGIN
    IF p_pct < 0 OR p_pct > 100 THEN
        RAISE EXCEPTION 'pct must be between 0 and 100, got %', p_pct;
    END IF;
    UPDATE shop.products
       SET price_cents = floor(price_cents * (1 + p_pct / 100.0))::int;
END;
$$;

-- Restock a product back to in_stock. Demonstrates an INOUT-style
-- procedure (returns rows-affected via RAISE NOTICE so it lives
-- under "Procedures" in the tree).
CREATE OR REPLACE PROCEDURE shop.restock_product(p_sku text)
LANGUAGE plpgsql AS $$
DECLARE
    affected int;
BEGIN
    UPDATE shop.products
       SET in_stock = true
     WHERE sku = p_sku;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE 'restock_product: % rows affected for sku %', affected, p_sku;
END;
$$;

-- Order summary as a function returning a SETOF — appears under
-- Routines as a function with a tabular return type.
CREATE OR REPLACE FUNCTION shop.order_summary(p_since timestamptz DEFAULT now() - interval '30 days')
RETURNS TABLE (
    status      text,
    order_count bigint,
    total_cents bigint,
    avg_cents   numeric
)
LANGUAGE sql STABLE AS $$
    SELECT o.status,
           count(*)::bigint                        AS order_count,
           sum(o.total_cents)::bigint              AS total_cents,
           avg(o.total_cents)::numeric(12, 2)      AS avg_cents
    FROM shop.orders o
    WHERE o.placed_at >= p_since
    GROUP BY o.status
    ORDER BY order_count DESC;
$$;

-- Scalar function — count of customers with at least one paid
-- order. A trivial demo function so the tree shows multiple FN
-- entries.
CREATE OR REPLACE FUNCTION shop.active_customer_count()
RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT count(DISTINCT o.customer_id)::bigint
    FROM shop.orders o
    WHERE o.status IN ('paid','shipped','delivered');
$$;

-- Format a price in USD cents → "$1,234.56" string. Appears as
-- a scalar fn under Routines.
CREATE OR REPLACE FUNCTION shop.format_price(p_cents integer)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT to_char(p_cents / 100.0, 'FM$999,999,990.00');
$$;

-- ────────────────────────────────────────────────────────────────────
-- shop seed data.
-- ────────────────────────────────────────────────────────────────────

INSERT INTO shop.customers (email, full_name, phone) VALUES
    ('ada@example.com',     'Ada Lovelace',    '+1-555-0100'),
    ('grace@example.com',   'Grace Hopper',    '+1-555-0101'),
    ('alan@example.com',    'Alan Turing',     '+44-20-7946-0958'),
    ('linus@example.com',   'Linus Torvalds',  '+358-9-1234567'),
    ('barbara@example.com', 'Barbara Liskov',  NULL),
    ('don@example.com',     'Donald Knuth',    NULL),
    ('claude@example.com',  'Claude Shannon',  '+1-555-0102'),
    ('john@example.com',    'John von Neumann', NULL);

INSERT INTO shop.categories (parent_id, name, slug) VALUES
    (NULL, 'Electronics',  'electronics'),
    (NULL, 'Furniture',    'furniture'),
    (NULL, 'Accessories',  'accessories');
INSERT INTO shop.categories (parent_id, name, slug) VALUES
    ((SELECT id FROM shop.categories WHERE slug = 'electronics'), 'Audio',     'audio'),
    ((SELECT id FROM shop.categories WHERE slug = 'electronics'), 'Displays',  'displays'),
    ((SELECT id FROM shop.categories WHERE slug = 'accessories'), 'Cables',    'cables');

INSERT INTO shop.products (sku, name, price_cents, in_stock, weight_g) VALUES
    ('KBD-001', 'Mechanical Keyboard',     12900, true, 1100),
    ('MON-027', '27" 4K Monitor',          39900, true, 6500),
    ('CHR-014', 'Ergonomic Chair',         54900, true, 18500),
    ('CBL-006', 'USB-C Cable (1m)',          990, true,   80),
    ('LMP-003', 'Desk Lamp',                4990, false, 1900),
    ('HPH-009', 'Studio Headphones',       19900, true,  340),
    ('DOC-002', 'USB-C Hub',                7900, true,  120);

INSERT INTO shop.product_categories (product_id, category_id)
SELECT p.id, c.id
FROM shop.products p
JOIN shop.categories c ON c.slug IN
    (CASE p.sku
        WHEN 'KBD-001' THEN 'accessories'
        WHEN 'MON-027' THEN 'displays'
        WHEN 'CHR-014' THEN 'furniture'
        WHEN 'CBL-006' THEN 'cables'
        WHEN 'LMP-003' THEN 'furniture'
        WHEN 'HPH-009' THEN 'audio'
        WHEN 'DOC-002' THEN 'cables'
     END);

INSERT INTO shop.addresses (customer_id, kind, line1, city, postcode, country, is_default)
SELECT c.id, k.kind,
       (ARRAY['12 Mathematics Way','7 Compiler St','42 Algorithm Rd','99 Recursion Loop'])[((c.id + ascii(k.kind))::int % 4) + 1],
       (ARRAY['London','Cambridge','Helsinki','Princeton'])[((c.id + ascii(k.kind))::int % 4) + 1],
       lpad(((c.id * 1000 + ascii(k.kind)) % 99999)::text, 5, '0'),
       (ARRAY['US','GB','FI','DE'])[((c.id)::int % 4) + 1],
       k.kind = 'billing'
FROM shop.customers c
CROSS JOIN (VALUES ('billing'), ('shipping')) AS k(kind);

INSERT INTO shop.orders (customer_id, billing_addr_id, shipping_addr_id, total_cents, status, placed_at)
SELECT
    c.id,
    (SELECT id FROM shop.addresses WHERE customer_id = c.id AND kind = 'billing'  LIMIT 1),
    (SELECT id FROM shop.addresses WHERE customer_id = c.id AND kind = 'shipping' LIMIT 1),
    floor(random() * 80000 + 990)::int,
    (ARRAY['pending','paid','shipped','delivered','cancelled','refunded'])[floor(random() * 6 + 1)],
    now() - (random() * interval '180 days')
FROM shop.customers c
CROSS JOIN generate_series(1, 6);  -- 6 orders per customer ≈ 48 orders

INSERT INTO shop.order_items (order_id, product_id, quantity, unit_cents)
SELECT o.id, p.id,
       floor(random() * 3 + 1)::int,
       p.price_cents
FROM shop.orders o
JOIN LATERAL (
    SELECT id, price_cents
    FROM shop.products
    ORDER BY random()
    LIMIT (1 + floor(random() * 3)::int)
) p ON true
ON CONFLICT (order_id, product_id) DO NOTHING;

INSERT INTO shop.shipments (order_id, carrier, tracking_number, shipped_at, delivered_at)
SELECT o.id,
       (ARRAY['ups','fedex','dhl','usps'])[floor(random() * 4 + 1)],
       'TRK-' || lpad(o.id::text, 8, '0'),
       o.placed_at + interval '2 days',
       CASE WHEN o.status = 'delivered'
            THEN o.placed_at + interval '5 days'
            ELSE NULL END
FROM shop.orders o
WHERE o.status IN ('shipped','delivered');

INSERT INTO shop.payments (order_id, method, amount_cents, captured_at, refunded)
SELECT o.id,
       (ARRAY['card','paypal','bank','gift_card','crypto'])[floor(random() * 5 + 1)],
       o.total_cents,
       o.placed_at + interval '5 minutes',
       o.status = 'refunded'
FROM shop.orders o
WHERE o.status <> 'pending';

-- ────────────────────────────────────────────────────────────────────
-- metrics schema — bigger table for testing the virtualised grid +
-- the schema-cache prefetch.
-- ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS metrics;

CREATE TABLE metrics.events (
    id          bigserial PRIMARY KEY,
    happened    timestamptz NOT NULL,
    actor       text        NOT NULL,
    customer_id integer     REFERENCES shop.customers (id) ON DELETE SET NULL,
    action      text        NOT NULL CHECK (action IN
        ('login','search','purchase','logout','refund','signup','view','click')),
    target      text,
    duration_ms integer     NOT NULL CHECK (duration_ms >= 0),
    success     boolean     NOT NULL DEFAULT true,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Bumped from 20k → 200k rows so the schema-cache prefetch + future
-- query-optimizer experiments have something with real selectivity
-- to chew on. ~3-5 s on a laptop; one-time cost on `docker compose up`.
INSERT INTO metrics.events (happened, actor, customer_id, action, target, duration_ms, success, metadata)
SELECT
    now() - (random() * interval '14 days'),
    (ARRAY['ada','grace','alan','linus','barbara','don','claude','john'])
        [floor(random() * 8 + 1)],
    CASE WHEN random() < 0.6 THEN floor(random() * 8 + 1)::int ELSE NULL END,
    (ARRAY['login','search','purchase','logout','refund','signup','view','click'])
        [floor(random() * 8 + 1)],
    CASE WHEN random() < 0.4
         THEN '/api/' || md5(random()::text)::text
         ELSE NULL END,
    floor(random() * 800 + 20)::int,
    random() > 0.05,
    jsonb_build_object(
        'browser', (ARRAY['chrome','firefox','safari','edge'])[floor(random() * 4 + 1)],
        'os',      (ARRAY['mac','linux','windows','ios','android'])[floor(random() * 5 + 1)],
        'mobile',  random() > 0.6
    )
FROM generate_series(1, 200000);

-- A handful of indexes so the "Indexes" folder is interesting and
-- query-optimizer experiments later have real plans to compare.
CREATE INDEX events_happened_idx
    ON metrics.events (happened DESC);
CREATE INDEX events_actor_happened_idx
    ON metrics.events (actor, happened DESC);
CREATE INDEX events_action_happened_idx
    ON metrics.events (action, happened DESC);
CREATE INDEX events_customer_idx
    ON metrics.events (customer_id)
    WHERE customer_id IS NOT NULL;
CREATE INDEX events_failed_idx
    ON metrics.events (happened DESC)
    WHERE NOT success;
CREATE INDEX events_metadata_gin_idx
    ON metrics.events USING gin (metadata);

-- A view so the tree shows views too. `day` is cast to plain DATE so
-- it matches MSSQL's `metrics.daily_event_counts.day` shape (the
-- view stays in parity across both seeds).
CREATE VIEW metrics.daily_event_counts AS
SELECT
    (happened AT TIME ZONE 'UTC')::date AS day,
    action,
    count(*)                          AS n,
    avg(duration_ms)::numeric(10, 2)  AS avg_duration_ms,
    sum(CASE WHEN NOT success THEN 1 ELSE 0 END) AS failures
FROM metrics.events
GROUP BY 1, 2;

-- A materialized view so the tree (eventually — drivers are
-- view+table aware via `relkind = 'm'`) can show pre-aggregated
-- snapshots and we can add a refresh routine to the procedures
-- folder.
CREATE MATERIALIZED VIEW metrics.daily_event_summary AS
SELECT
    (happened AT TIME ZONE 'UTC')::date AS day,
    count(*)                          AS total,
    sum(CASE WHEN success THEN 0 ELSE 1 END) AS failures,
    avg(duration_ms)::numeric(10, 2)  AS avg_duration_ms
FROM metrics.events
GROUP BY 1;
CREATE UNIQUE INDEX daily_event_summary_day_idx
    ON metrics.daily_event_summary (day);

CREATE OR REPLACE PROCEDURE metrics.refresh_daily_summary()
LANGUAGE sql AS $$
    REFRESH MATERIALIZED VIEW CONCURRENTLY metrics.daily_event_summary;
$$;

-- A "wide" telemetry table — 32 columns of mixed types so the
-- results grid's *horizontal* scroll has something to render. 500
-- rows is plenty since the focus here is column count.
CREATE TABLE metrics.wide_records (
    id              bigserial PRIMARY KEY,
    recorded_at     timestamptz NOT NULL,
    source          text        NOT NULL,
    environment     text        NOT NULL,
    service         text        NOT NULL,
    region          text        NOT NULL,
    host            text        NOT NULL,
    pid             integer     NOT NULL,
    thread_id       integer     NOT NULL,
    user_id         text        NOT NULL,
    session_id      uuid        NOT NULL,
    request_id      uuid        NOT NULL,
    trace_id        text        NOT NULL,
    span_id         text        NOT NULL,
    http_method     text        NOT NULL,
    http_status     integer     NOT NULL,
    http_path       text        NOT NULL,
    duration_ms     integer     NOT NULL,
    bytes_in        bigint      NOT NULL,
    bytes_out       bigint      NOT NULL,
    cpu_pct         double precision NOT NULL,
    mem_mb          double precision NOT NULL,
    queue_depth     integer     NOT NULL,
    retry_count     integer     NOT NULL,
    success         boolean     NOT NULL,
    error_kind      text,
    error_message   text,
    tag_a           text,
    tag_b           text,
    tag_c           text,
    cost_cents      integer     NOT NULL,
    note            text
);
CREATE INDEX wide_recorded_at_idx
    ON metrics.wide_records (recorded_at DESC);
CREATE INDEX wide_service_idx
    ON metrics.wide_records (service, recorded_at DESC);
CREATE INDEX wide_failures_idx
    ON metrics.wide_records (recorded_at DESC)
    WHERE NOT success;

INSERT INTO metrics.wide_records (
    recorded_at, source, environment, service, region, host, pid, thread_id,
    user_id, session_id, request_id, trace_id, span_id, http_method,
    http_status, http_path, duration_ms, bytes_in, bytes_out, cpu_pct,
    mem_mb, queue_depth, retry_count, success, error_kind, error_message,
    tag_a, tag_b, tag_c, cost_cents, note
)
SELECT
    now() - (random() * interval '7 days'),
    (ARRAY['api','worker','cron','sidecar','batch'])[floor(random() * 5 + 1)],
    (ARRAY['prod','staging','dev'])[floor(random() * 3 + 1)],
    (ARRAY['orders','catalog','billing','search','auth','notifications'])[floor(random() * 6 + 1)],
    (ARRAY['us-east-1','us-west-2','eu-west-1','ap-south-1'])[floor(random() * 4 + 1)],
    'host-' || lpad(floor(random() * 99 + 1)::text, 2, '0'),
    floor(random() * 30000 + 1000)::int,
    floor(random() * 32 + 1)::int,
    'user_' || floor(random() * 5000 + 1)::text,
    gen_random_uuid(),
    gen_random_uuid(),
    md5(random()::text),
    substring(md5(random()::text), 1, 16),
    (ARRAY['GET','POST','PUT','DELETE','PATCH'])[floor(random() * 5 + 1)],
    (ARRAY[200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 500, 502, 503])
        [floor(random() * 14 + 1)],
    (ARRAY[
        '/api/orders', '/api/orders/:id', '/api/users/me',
        '/api/products', '/api/products/:sku', '/api/checkout',
        '/api/billing/invoices', '/healthz', '/api/search'
    ])[floor(random() * 9 + 1)],
    floor(random() * 1500 + 5)::int,
    floor(random() * 65536)::bigint,
    floor(random() * 524288)::bigint,
    round((random() * 100)::numeric, 2)::double precision,
    round((random() * 4096)::numeric, 1)::double precision,
    floor(random() * 64)::int,
    floor(random() * 4)::int,
    random() > 0.15,
    CASE WHEN random() > 0.85
         THEN (ARRAY['Timeout','UpstreamError','ValidationError','NotFound','RateLimited'])
              [floor(random() * 5 + 1)]
         ELSE NULL END,
    CASE WHEN random() > 0.85
         THEN 'unhandled exception at ' || md5(random()::text)
         ELSE NULL END,
    'tier:' || (ARRAY['free','pro','enterprise'])[floor(random() * 3 + 1)],
    'team:' || (ARRAY['alpha','beta','gamma','delta'])[floor(random() * 4 + 1)],
    'feature:' || (ARRAY['v1','v2','beta','dark'])[floor(random() * 4 + 1)],
    floor(random() * 5000)::int,
    CASE WHEN random() > 0.7
         THEN 'arbitrary descriptive note ' || md5(random()::text)
         ELSE NULL END
FROM generate_series(1, 500);

-- Refresh stats so the planner has accurate selectivity for the
-- query-optimizer experiments later.
ANALYZE shop.customers, shop.products, shop.orders, shop.order_items,
        shop.categories, shop.product_categories, shop.addresses,
        shop.shipments, shop.payments, shop.audit_log,
        metrics.events, metrics.wide_records;
REFRESH MATERIALIZED VIEW metrics.daily_event_summary;
