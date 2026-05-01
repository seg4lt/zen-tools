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

INSERT INTO metrics.events (happened, actor, action, duration_ms)
SELECT
    now() - (random() * interval '14 days'),
    (ARRAY['ada','grace','alan','linus','barbara'])[floor(random() * 5 + 1)],
    (ARRAY['login','search','purchase','logout','refund','signup'])[floor(random() * 6 + 1)],
    floor(random() * 800 + 20)::int
FROM generate_series(1, 500);

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
