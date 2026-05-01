-- Seed schema + data for the Database Explorer demo.
-- Runs once on first container start (postgres image's standard
-- /docker-entrypoint-initdb.d/ hook). Re-running `docker compose up` does
-- not re-execute this file unless the pg_data volume is wiped.

-- ────────────────────────────────────────────────────────────────────────
-- "shop" schema — small e-commerce slice
-- ────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS shop;

CREATE TABLE shop.customers (
    id          serial PRIMARY KEY,
    email       text        NOT NULL UNIQUE,
    full_name   text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.products (
    id          serial PRIMARY KEY,
    sku         text        NOT NULL UNIQUE,
    name        text        NOT NULL,
    price_cents integer     NOT NULL CHECK (price_cents >= 0),
    in_stock    boolean     NOT NULL DEFAULT true
);

CREATE TABLE shop.orders (
    id            serial PRIMARY KEY,
    customer_id   integer     NOT NULL REFERENCES shop.customers (id),
    placed_at     timestamptz NOT NULL DEFAULT now(),
    total_cents   integer     NOT NULL CHECK (total_cents >= 0),
    status        text        NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled'))
);

CREATE TABLE shop.order_items (
    order_id   integer NOT NULL REFERENCES shop.orders   (id) ON DELETE CASCADE,
    product_id integer NOT NULL REFERENCES shop.products (id),
    quantity   integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id)
);

INSERT INTO shop.customers (email, full_name) VALUES
    ('ada@example.com',     'Ada Lovelace'),
    ('grace@example.com',   'Grace Hopper'),
    ('alan@example.com',    'Alan Turing'),
    ('linus@example.com',   'Linus Torvalds'),
    ('barbara@example.com', 'Barbara Liskov');

INSERT INTO shop.products (sku, name, price_cents, in_stock) VALUES
    ('KBD-001', 'Mechanical Keyboard',     12900, true),
    ('MON-027', '27" 4K Monitor',          39900, true),
    ('CHR-014', 'Ergonomic Chair',         54900, true),
    ('CBL-006', 'USB-C Cable (1m)',          990, true),
    ('LMP-003', 'Desk Lamp',                4990, false);

INSERT INTO shop.orders (customer_id, total_cents, status) VALUES
    (1, 12900, 'paid'),
    (1, 40890, 'shipped'),
    (2, 54900, 'pending'),
    (3,  1980, 'cancelled'),
    (4, 14890, 'paid');

INSERT INTO shop.order_items (order_id, product_id, quantity) VALUES
    (1, 1, 1),
    (2, 2, 1),
    (2, 4, 1),
    (3, 3, 1),
    (4, 4, 2),
    (5, 1, 1),
    (5, 4, 2);

-- ────────────────────────────────────────────────────────────────────────
-- "metrics" schema — bigger table for testing the virtualised grid
-- ────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS metrics;

CREATE TABLE metrics.events (
    id        bigserial PRIMARY KEY,
    happened  timestamptz NOT NULL,
    actor     text        NOT NULL,
    action    text        NOT NULL,
    duration_ms integer   NOT NULL
);

-- 20k rows to exercise virtualised grid scroll performance.  Bump this
-- to 200k+ if you want to really stress-test — generation takes a few
-- seconds either way.
INSERT INTO metrics.events (happened, actor, action, duration_ms)
SELECT
    now() - (random() * interval '14 days'),
    (ARRAY['ada','grace','alan','linus','barbara'])[floor(random() * 5 + 1)],
    (ARRAY['login','search','purchase','logout','refund','signup'])[floor(random() * 6 + 1)],
    floor(random() * 800 + 20)::int
FROM generate_series(1, 20000);

CREATE INDEX events_happened_idx ON metrics.events (happened DESC);

-- A view so the tree shows views too.
CREATE VIEW metrics.daily_event_counts AS
SELECT
    date_trunc('day', happened) AS day,
    action,
    count(*) AS n
FROM metrics.events
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ────────────────────────────────────────────────────────────────────────
-- "metrics" : a wide telemetry table — 32 columns of mixed types so we
-- can exercise the results grid's *horizontal* scroll. 500 rows is
-- plenty since the focus here is column count, not row count.
-- ────────────────────────────────────────────────────────────────────────
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

CREATE INDEX wide_recorded_at_idx ON metrics.wide_records (recorded_at DESC);
