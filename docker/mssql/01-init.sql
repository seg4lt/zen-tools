-- Seed schema + data for the Database Explorer demo.
-- Idempotent: safe to re-run because the mssql-init sidecar applies
-- it on every `docker compose up` (mssql has no built-in entrypoint
-- init dir).
--
-- Mirrors the richness of the Postgres seed (docker/postgres/01-init.sql)
-- so the DataGrip-style tree expansion and the schema-cache prefetch
-- have plenty to chew on: composite + filtered indexes, FKs, CHECKs,
-- triggers, audit log, and a couple of stored procedures + functions.

IF DB_ID('zen_dev') IS NULL
BEGIN
    CREATE DATABASE zen_dev;
END
GO

USE zen_dev;
GO

-- ────────────────────────────────────────────────────────────────────
-- shop schema
-- ────────────────────────────────────────────────────────────────────
IF SCHEMA_ID('shop') IS NULL EXEC('CREATE SCHEMA shop');
GO

-- Drop in dependency-reverse order so re-runs are clean.
IF OBJECT_ID('shop.customer_lifetime_value', 'FN') IS NOT NULL DROP FUNCTION shop.customer_lifetime_value;
IF OBJECT_ID('shop.archive_old_orders',     'P')  IS NOT NULL DROP PROCEDURE shop.archive_old_orders;
IF OBJECT_ID('shop.payments',         'U')  IS NOT NULL DROP TABLE shop.payments;
IF OBJECT_ID('shop.shipments',        'U')  IS NOT NULL DROP TABLE shop.shipments;
IF OBJECT_ID('shop.order_items',      'U')  IS NOT NULL DROP TABLE shop.order_items;
IF OBJECT_ID('shop.orders',           'U')  IS NOT NULL DROP TABLE shop.orders;
IF OBJECT_ID('shop.product_categories','U') IS NOT NULL DROP TABLE shop.product_categories;
IF OBJECT_ID('shop.addresses',        'U')  IS NOT NULL DROP TABLE shop.addresses;
IF OBJECT_ID('shop.products',         'U')  IS NOT NULL DROP TABLE shop.products;
IF OBJECT_ID('shop.categories',       'U')  IS NOT NULL DROP TABLE shop.categories;
IF OBJECT_ID('shop.customers',        'U')  IS NOT NULL DROP TABLE shop.customers;
IF OBJECT_ID('shop.audit_log',        'U')  IS NOT NULL DROP TABLE shop.audit_log;
GO

-- Append-only audit ledger. Defined first so triggers below can
-- reference it.
CREATE TABLE shop.audit_log (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    table_name  NVARCHAR(128) NOT NULL,
    op          NVARCHAR(8)   NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
    row_pk      NVARCHAR(64)  NOT NULL,
    changed_at  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    changed_by  NVARCHAR(128) NULL
);
CREATE INDEX audit_log_table_changed_idx
    ON shop.audit_log (table_name, changed_at DESC);
GO

CREATE TABLE shop.customers (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    email       NVARCHAR(255) NOT NULL CONSTRAINT customers_email_unique UNIQUE,
    full_name   NVARCHAR(255) NOT NULL CONSTRAINT customers_name_not_blank CHECK (LEN(full_name) > 0),
    phone       NVARCHAR(64)  NULL,
    is_active   BIT           NOT NULL CONSTRAINT customers_active_default DEFAULT 1,
    created_at  DATETIME2     NOT NULL CONSTRAINT customers_created_default DEFAULT SYSUTCDATETIME(),
    updated_at  DATETIME2     NOT NULL CONSTRAINT customers_updated_default DEFAULT SYSUTCDATETIME()
);
CREATE INDEX customers_active_idx
    ON shop.customers (created_at DESC)
    WHERE is_active = 1;
GO

-- Simple updated_at bumper. MSSQL doesn't have a generic "tg_set"
-- function reusable across tables — each table needs its own
-- trigger. We only wire the ones below; readers can extend trivially.
CREATE TRIGGER shop.customers_set_updated_at
    ON shop.customers
    AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE c SET updated_at = SYSUTCDATETIME()
    FROM shop.customers c
    INNER JOIN inserted i ON i.id = c.id;
END
GO

CREATE TRIGGER shop.customers_audit
    ON shop.customers
    AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO shop.audit_log (table_name, op, row_pk, changed_by)
    SELECT 'customers',
           CASE WHEN EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted) THEN 'UPDATE'
                WHEN EXISTS (SELECT 1 FROM inserted) THEN 'INSERT'
                ELSE 'DELETE' END,
           CAST(COALESCE(i.id, d.id) AS NVARCHAR(64)),
           SUSER_SNAME()
    FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
END
GO

-- Self-referencing taxonomy.
CREATE TABLE shop.categories (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    parent_id   INT NULL CONSTRAINT categories_parent_fk REFERENCES shop.categories (id),
    name        NVARCHAR(128) NOT NULL CONSTRAINT categories_name_not_blank CHECK (LEN(name) > 0),
    slug        NVARCHAR(128) NOT NULL CONSTRAINT categories_slug_unique UNIQUE,
    created_at  DATETIME2 NOT NULL CONSTRAINT categories_created_default DEFAULT SYSUTCDATETIME(),
    updated_at  DATETIME2 NOT NULL CONSTRAINT categories_updated_default DEFAULT SYSUTCDATETIME()
);
CREATE INDEX categories_parent_idx ON shop.categories (parent_id);
GO

CREATE TABLE shop.products (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    sku         NVARCHAR(64)  NOT NULL CONSTRAINT products_sku_unique UNIQUE,
    name        NVARCHAR(255) NOT NULL CONSTRAINT products_name_not_blank CHECK (LEN(name) > 0),
    price_cents INT           NOT NULL CONSTRAINT products_price_nonneg CHECK (price_cents >= 0),
    in_stock    BIT           NOT NULL CONSTRAINT products_in_stock_default DEFAULT 1,
    weight_g    INT           NULL CONSTRAINT products_weight_positive CHECK (weight_g IS NULL OR weight_g > 0),
    created_at  DATETIME2     NOT NULL CONSTRAINT products_created_default DEFAULT SYSUTCDATETIME(),
    updated_at  DATETIME2     NOT NULL CONSTRAINT products_updated_default DEFAULT SYSUTCDATETIME()
);
-- Filtered index — only in-stock rows.
CREATE INDEX products_in_stock_price_idx
    ON shop.products (price_cents)
    WHERE in_stock = 1;
GO

CREATE TABLE shop.product_categories (
    product_id  INT NOT NULL CONSTRAINT product_categories_product_fk
        REFERENCES shop.products (id) ON DELETE CASCADE,
    category_id INT NOT NULL CONSTRAINT product_categories_category_fk
        REFERENCES shop.categories (id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category_idx
    ON shop.product_categories (category_id);
GO

CREATE TABLE shop.addresses (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    customer_id INT NOT NULL CONSTRAINT addresses_customer_fk
        REFERENCES shop.customers (id) ON DELETE CASCADE,
    kind        NVARCHAR(16) NOT NULL CONSTRAINT addresses_kind_check CHECK (kind IN ('billing','shipping')),
    line1       NVARCHAR(255) NOT NULL,
    line2       NVARCHAR(255) NULL,
    city        NVARCHAR(128) NOT NULL,
    postcode    NVARCHAR(32)  NOT NULL,
    country     NVARCHAR(2)   NOT NULL CONSTRAINT addresses_country_default DEFAULT 'US'
                              CONSTRAINT addresses_country_check CHECK (LEN(country) = 2),
    is_default  BIT           NOT NULL CONSTRAINT addresses_default_default DEFAULT 0,
    created_at  DATETIME2     NOT NULL CONSTRAINT addresses_created_default DEFAULT SYSUTCDATETIME()
);
CREATE INDEX addresses_customer_idx ON shop.addresses (customer_id);
-- Filtered unique — at most one default per (customer, kind).
CREATE UNIQUE INDEX addresses_default_per_kind_idx
    ON shop.addresses (customer_id, kind)
    WHERE is_default = 1;
GO

CREATE TABLE shop.orders (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    customer_id     INT NOT NULL CONSTRAINT orders_customer_fk
        REFERENCES shop.customers (id),
    -- NB: cannot ON DELETE SET NULL on multiple FKs into shop.addresses
    -- because MSSQL doesn't allow multiple cascade paths into the same
    -- table; we use NO ACTION (the default) and let app code clean up.
    billing_addr_id  INT NULL CONSTRAINT orders_billing_addr_fk
        REFERENCES shop.addresses (id),
    shipping_addr_id INT NULL CONSTRAINT orders_shipping_addr_fk
        REFERENCES shop.addresses (id),
    placed_at       DATETIME2     NOT NULL CONSTRAINT orders_placed_default DEFAULT SYSUTCDATETIME(),
    total_cents     INT           NOT NULL CONSTRAINT orders_total_nonneg CHECK (total_cents >= 0),
    status          NVARCHAR(16)  NOT NULL CONSTRAINT orders_status_check
        CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),
    note            NVARCHAR(512) NULL,
    created_at      DATETIME2     NOT NULL CONSTRAINT orders_created_default DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2     NOT NULL CONSTRAINT orders_updated_default DEFAULT SYSUTCDATETIME()
);
CREATE INDEX orders_customer_placed_idx
    ON shop.orders (customer_id, placed_at DESC);
CREATE INDEX orders_status_placed_idx
    ON shop.orders (status, placed_at DESC);
CREATE INDEX orders_live_idx
    ON shop.orders (placed_at DESC)
    WHERE status IN ('pending','paid','shipped');
GO

CREATE TRIGGER shop.orders_audit
    ON shop.orders
    AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO shop.audit_log (table_name, op, row_pk, changed_by)
    SELECT 'orders',
           CASE WHEN EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted) THEN 'UPDATE'
                WHEN EXISTS (SELECT 1 FROM inserted) THEN 'INSERT'
                ELSE 'DELETE' END,
           CAST(COALESCE(i.id, d.id) AS NVARCHAR(64)),
           SUSER_SNAME()
    FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
END
GO

CREATE TABLE shop.order_items (
    order_id    INT NOT NULL CONSTRAINT order_items_order_fk
        REFERENCES shop.orders (id) ON DELETE CASCADE,
    product_id  INT NOT NULL CONSTRAINT order_items_product_fk
        REFERENCES shop.products (id),
    quantity    INT NOT NULL CONSTRAINT order_items_qty_positive CHECK (quantity > 0),
    unit_cents  INT NOT NULL CONSTRAINT order_items_unit_nonneg CHECK (unit_cents >= 0),
    PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_items_product_idx ON shop.order_items (product_id);
GO

CREATE TABLE shop.shipments (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    order_id        INT NOT NULL CONSTRAINT shipments_order_fk
        REFERENCES shop.orders (id) ON DELETE CASCADE,
    carrier         NVARCHAR(16) NOT NULL CONSTRAINT shipments_carrier_check
        CHECK (carrier IN ('ups','fedex','dhl','usps')),
    tracking_number NVARCHAR(64) NOT NULL,
    shipped_at      DATETIME2 NULL,
    delivered_at    DATETIME2 NULL,
    CONSTRAINT shipments_carrier_tracking_unique UNIQUE (carrier, tracking_number),
    CONSTRAINT shipments_delivery_after_ship_check
        CHECK (delivered_at IS NULL OR shipped_at IS NULL OR delivered_at >= shipped_at)
);
CREATE INDEX shipments_order_idx ON shop.shipments (order_id);
CREATE INDEX shipments_pending_idx
    ON shop.shipments (shipped_at)
    WHERE delivered_at IS NULL;
GO

CREATE TABLE shop.payments (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    order_id    INT NOT NULL CONSTRAINT payments_order_fk
        REFERENCES shop.orders (id) ON DELETE CASCADE,
    method      NVARCHAR(16) NOT NULL CONSTRAINT payments_method_check
        CHECK (method IN ('card','paypal','bank','gift_card','crypto')),
    amount_cents INT NOT NULL CONSTRAINT payments_amount_positive CHECK (amount_cents > 0),
    captured_at DATETIME2 NOT NULL CONSTRAINT payments_captured_default DEFAULT SYSUTCDATETIME(),
    refunded    BIT NOT NULL CONSTRAINT payments_refunded_default DEFAULT 0,
    notes       NVARCHAR(512) NULL
);
CREATE INDEX payments_order_idx ON shop.payments (order_id);
CREATE INDEX payments_method_captured_idx
    ON shop.payments (method, captured_at DESC);
GO

-- ────────────────────────────────────────────────────────────────────
-- shop functions + procedures (drives the per-schema "Routines" folder).
-- ────────────────────────────────────────────────────────────────────

CREATE FUNCTION shop.customer_lifetime_value(@customer INT)
RETURNS BIGINT
AS
BEGIN
    DECLARE @total BIGINT;
    SELECT @total = COALESCE(SUM(CAST(total_cents AS BIGINT)), 0)
    FROM shop.orders
    WHERE customer_id = @customer
      AND status IN ('paid','shipped','delivered');
    RETURN @total;
END
GO

CREATE PROCEDURE shop.archive_old_orders
    @cutoff DATETIME2
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM shop.orders
    WHERE placed_at < @cutoff
      AND status = 'cancelled';
END
GO

IF OBJECT_ID('shop.bump_prices', 'P') IS NOT NULL DROP PROCEDURE shop.bump_prices;
GO
CREATE PROCEDURE shop.bump_prices
    @pct DECIMAL(5,2)
AS
BEGIN
    SET NOCOUNT ON;
    IF @pct < 0 OR @pct > 100
    BEGIN
        -- RAISERROR substitution params don't accept DECIMAL — cast to
        -- NVARCHAR and pass as %s instead.
        DECLARE @pct_str NVARCHAR(16) = CONVERT(NVARCHAR(16), @pct);
        RAISERROR('pct must be between 0 and 100, got %s', 16, 1, @pct_str);
        RETURN;
    END
    UPDATE shop.products
       SET price_cents = CAST(price_cents * (1 + @pct / 100.0) AS INT);
END
GO

IF OBJECT_ID('shop.restock_product', 'P') IS NOT NULL DROP PROCEDURE shop.restock_product;
GO
CREATE PROCEDURE shop.restock_product
    @sku NVARCHAR(64)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE shop.products SET in_stock = 1 WHERE sku = @sku;
    PRINT 'restock_product: ' + CAST(@@ROWCOUNT AS NVARCHAR(10)) + ' row(s) for ' + @sku;
END
GO

-- Inline TVF — appears as a function with a TABLE return type.
IF OBJECT_ID('shop.order_summary', 'IF') IS NOT NULL DROP FUNCTION shop.order_summary;
GO
CREATE FUNCTION shop.order_summary(@since DATETIME2)
RETURNS TABLE
AS
RETURN
(
    SELECT
        o.status,
        COUNT(*)              AS order_count,
        SUM(o.total_cents)    AS total_cents,
        AVG(CAST(o.total_cents AS DECIMAL(12,2))) AS avg_cents
    FROM shop.orders o
    WHERE o.placed_at >= @since
    GROUP BY o.status
);
GO

-- Scalar function — count of customers with at least one paid
-- order. Multiple FN entries under Routines.
IF OBJECT_ID('shop.active_customer_count', 'FN') IS NOT NULL DROP FUNCTION shop.active_customer_count;
GO
CREATE FUNCTION shop.active_customer_count()
RETURNS BIGINT
AS
BEGIN
    DECLARE @n BIGINT;
    SELECT @n = COUNT(DISTINCT customer_id)
    FROM shop.orders
    WHERE status IN ('paid','shipped','delivered');
    RETURN @n;
END
GO

-- Pretty-print cents → "$1,234.56" — scalar fn.
IF OBJECT_ID('shop.format_price', 'FN') IS NOT NULL DROP FUNCTION shop.format_price;
GO
CREATE FUNCTION shop.format_price(@cents INT)
RETURNS NVARCHAR(32)
AS
BEGIN
    RETURN '$' + FORMAT(@cents / 100.0, 'N2');
END
GO

-- ────────────────────────────────────────────────────────────────────
-- shop seed data.
-- ────────────────────────────────────────────────────────────────────
INSERT INTO shop.customers (email, full_name, phone) VALUES
    ('ada@example.com',     N'Ada Lovelace',     '+1-555-0100'),
    ('grace@example.com',   N'Grace Hopper',     '+1-555-0101'),
    ('alan@example.com',    N'Alan Turing',      '+44-20-7946-0958'),
    ('linus@example.com',   N'Linus Torvalds',   '+358-9-1234567'),
    ('barbara@example.com', N'Barbara Liskov',   NULL),
    ('don@example.com',     N'Donald Knuth',     NULL),
    ('claude@example.com',  N'Claude Shannon',   '+1-555-0102'),
    ('john@example.com',    N'John von Neumann', NULL);

INSERT INTO shop.categories (parent_id, name, slug) VALUES
    (NULL, N'Electronics', 'electronics'),
    (NULL, N'Furniture',   'furniture'),
    (NULL, N'Accessories', 'accessories');
INSERT INTO shop.categories (parent_id, name, slug) VALUES
    ((SELECT id FROM shop.categories WHERE slug = 'electronics'), N'Audio',     'audio'),
    ((SELECT id FROM shop.categories WHERE slug = 'electronics'), N'Displays',  'displays'),
    ((SELECT id FROM shop.categories WHERE slug = 'accessories'), N'Cables',    'cables');

INSERT INTO shop.products (sku, name, price_cents, in_stock, weight_g) VALUES
    ('KBD-001', N'Mechanical Keyboard', 12900, 1, 1100),
    ('MON-027', N'27" 4K Monitor',      39900, 1, 6500),
    ('CHR-014', N'Ergonomic Chair',     54900, 1, 18500),
    ('CBL-006', N'USB-C Cable (1m)',      990, 1,   80),
    ('LMP-003', N'Desk Lamp',            4990, 0, 1900),
    ('HPH-009', N'Studio Headphones',   19900, 1,  340),
    ('DOC-002', N'USB-C Hub',            7900, 1,  120);

INSERT INTO shop.product_categories (product_id, category_id)
SELECT p.id, c.id
FROM shop.products p
JOIN shop.categories c
  ON c.slug = (CASE p.sku
                  WHEN 'KBD-001' THEN 'accessories'
                  WHEN 'MON-027' THEN 'displays'
                  WHEN 'CHR-014' THEN 'furniture'
                  WHEN 'CBL-006' THEN 'cables'
                  WHEN 'LMP-003' THEN 'furniture'
                  WHEN 'HPH-009' THEN 'audio'
                  WHEN 'DOC-002' THEN 'cables'
                END);

-- One billing + one shipping address per customer.
INSERT INTO shop.addresses (customer_id, kind, line1, city, postcode, country, is_default)
SELECT c.id, k.kind,
       N'12 Mathematics Way',
       N'Cambridge',
       '02142',
       'US',
       CASE WHEN k.kind = 'billing' THEN 1 ELSE 0 END
FROM shop.customers c
CROSS JOIN (VALUES ('billing'), ('shipping')) AS k(kind);

-- 6 orders per customer ≈ 48 orders; randomized status for a mix.
;WITH order_seed AS (
    SELECT c.id AS customer_id,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY (SELECT NULL)) AS n,
           (CHECKSUM(NEWID()) & 0x7FFFFFFF) AS r
    FROM shop.customers c
    CROSS JOIN (VALUES (1),(2),(3),(4),(5),(6)) AS s(n)
)
INSERT INTO shop.orders (customer_id, billing_addr_id, shipping_addr_id, placed_at, total_cents, status)
SELECT
    o.customer_id,
    (SELECT TOP 1 id FROM shop.addresses WHERE customer_id = o.customer_id AND kind = 'billing'),
    (SELECT TOP 1 id FROM shop.addresses WHERE customer_id = o.customer_id AND kind = 'shipping'),
    DATEADD(DAY, -(o.r % 180), SYSUTCDATETIME()),
    990 + (o.r % 80000),
    CHOOSE((o.r % 6) + 1, 'pending','paid','shipped','delivered','cancelled','refunded')
FROM order_seed o;
GO

-- One product line per order (kept simple — composite PK enforces
-- uniqueness so we don't try to seed two of the same product).
INSERT INTO shop.order_items (order_id, product_id, quantity, unit_cents)
SELECT o.id,
       (SELECT TOP 1 p.id FROM shop.products p ORDER BY NEWID()),
       1 + (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 3,
       990 + (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 50000
FROM shop.orders o;
GO

-- NB: CHOOSE(expr, …) expands to CASE WHEN expr=1 … WHEN expr=2 …, so
-- when expr contains NEWID() it is re-evaluated per branch and often
-- matches none → NULL. Materialize the random index once per row via
-- CROSS APPLY (VALUES …) so NEWID() is invoked exactly once.
INSERT INTO shop.shipments (order_id, carrier, tracking_number, shipped_at, delivered_at)
SELECT o.id,
       CHOOSE(r.idx, 'ups','fedex','dhl','usps'),
       'TRK-' + RIGHT('00000000' + CAST(o.id AS NVARCHAR(8)), 8),
       DATEADD(DAY, 2, o.placed_at),
       CASE WHEN o.status = 'delivered' THEN DATEADD(DAY, 5, o.placed_at) ELSE NULL END
FROM shop.orders o
CROSS APPLY (VALUES ((CHECKSUM(NEWID()) & 0x7FFFFFFF) % 4 + 1)) AS r(idx)
WHERE o.status IN ('shipped','delivered');

INSERT INTO shop.payments (order_id, method, amount_cents, captured_at, refunded)
SELECT o.id,
       CHOOSE(r.idx, 'card','paypal','bank','gift_card','crypto'),
       o.total_cents,
       DATEADD(MINUTE, 5, o.placed_at),
       CASE WHEN o.status = 'refunded' THEN 1 ELSE 0 END
FROM shop.orders o
CROSS APPLY (VALUES ((CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5 + 1)) AS r(idx)
WHERE o.status <> 'pending';
GO

-- ────────────────────────────────────────────────────────────────────
-- metrics schema
-- ────────────────────────────────────────────────────────────────────
IF SCHEMA_ID('metrics') IS NULL EXEC('CREATE SCHEMA metrics');
GO

IF OBJECT_ID('metrics.daily_event_counts', 'V') IS NOT NULL DROP VIEW metrics.daily_event_counts;
IF OBJECT_ID('metrics.events',             'U') IS NOT NULL DROP TABLE metrics.events;
IF OBJECT_ID('metrics.wide_records',       'U') IS NOT NULL DROP TABLE metrics.wide_records;
GO

CREATE TABLE metrics.events (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    happened    DATETIME2     NOT NULL,
    actor       NVARCHAR(64)  NOT NULL,
    customer_id INT           NULL CONSTRAINT events_customer_fk
        REFERENCES shop.customers (id),
    action      NVARCHAR(64)  NOT NULL CONSTRAINT events_action_check
        CHECK (action IN ('login','search','purchase','logout','refund','signup','view','click')),
    target      NVARCHAR(256) NULL,
    duration_ms INT           NOT NULL CONSTRAINT events_duration_nonneg CHECK (duration_ms >= 0),
    success     BIT           NOT NULL CONSTRAINT events_success_default DEFAULT 1
);
GO

-- Bumped from 20k → 200k rows. Generated via two cross-joins of
-- sys.all_objects (~32k each) so we have enough source rows.
;WITH nums AS (
    SELECT TOP (200000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
-- Materialize each random pick once per row via CROSS APPLY so CHOOSE
-- doesn't re-evaluate NEWID() per CASE branch (which produces NULL).
INSERT INTO metrics.events (happened, actor, customer_id, action, target, duration_ms, success)
SELECT
    DATEADD(MINUTE, -r.minutes_back, SYSUTCDATETIME()),
    CHOOSE(r.actor_idx,
           N'ada', N'grace', N'alan', N'linus', N'barbara', N'don', N'claude', N'john'),
    CASE WHEN r.cust_present < 60 THEN r.cust_id ELSE NULL END,
    CHOOSE(r.action_idx,
           N'login', N'search', N'purchase', N'logout', N'refund', N'signup', N'view', N'click'),
    CASE WHEN r.target_present < 40
         THEN N'/api/' + LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2))
         ELSE NULL END,
    20 + r.dur,
    CASE WHEN r.success_roll < 95 THEN 1 ELSE 0 END
FROM nums
CROSS APPLY (VALUES (
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % (60 * 24 * 14),
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 8 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 8 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 8 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 800,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100
)) AS r(minutes_back, actor_idx, cust_present, cust_id, action_idx, target_present, dur, success_roll);
GO

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
    WHERE success = 0;
GO

CREATE VIEW metrics.daily_event_counts AS
SELECT
    CAST(happened AS DATE) AS day,
    action,
    COUNT(*)               AS n,
    AVG(CAST(duration_ms AS DECIMAL(10,2))) AS avg_duration_ms,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
FROM metrics.events
GROUP BY CAST(happened AS DATE), action;
GO

-- ────────────────────────────────────────────────────────────────────
-- "metrics" : a wide telemetry table — 32 columns of mixed types so
-- the results grid's *horizontal* scroll has something to render.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE metrics.wide_records (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    recorded_at     DATETIME2         NOT NULL,
    source          NVARCHAR(32)      NOT NULL,
    environment     NVARCHAR(16)      NOT NULL,
    service         NVARCHAR(32)      NOT NULL,
    region          NVARCHAR(32)      NOT NULL,
    host            NVARCHAR(64)      NOT NULL,
    pid             INT               NOT NULL,
    thread_id       INT               NOT NULL,
    user_id         NVARCHAR(64)      NOT NULL,
    session_id      UNIQUEIDENTIFIER  NOT NULL,
    request_id      UNIQUEIDENTIFIER  NOT NULL,
    trace_id        NVARCHAR(64)      NOT NULL,
    span_id         NVARCHAR(32)      NOT NULL,
    http_method     NVARCHAR(8)       NOT NULL,
    http_status     INT               NOT NULL,
    http_path       NVARCHAR(128)     NOT NULL,
    duration_ms     INT               NOT NULL,
    bytes_in        BIGINT            NOT NULL,
    bytes_out       BIGINT            NOT NULL,
    cpu_pct         FLOAT             NOT NULL,
    mem_mb          FLOAT             NOT NULL,
    queue_depth     INT               NOT NULL,
    retry_count     INT               NOT NULL,
    success         BIT               NOT NULL,
    error_kind      NVARCHAR(32)      NULL,
    error_message   NVARCHAR(256)     NULL,
    tag_a           NVARCHAR(32)      NULL,
    tag_b           NVARCHAR(32)      NULL,
    tag_c           NVARCHAR(32)      NULL,
    cost_cents      INT               NOT NULL,
    note            NVARCHAR(256)     NULL
);
CREATE INDEX wide_recorded_at_idx
    ON metrics.wide_records (recorded_at DESC);
CREATE INDEX wide_service_idx
    ON metrics.wide_records (service, recorded_at DESC);
CREATE INDEX wide_failures_idx
    ON metrics.wide_records (recorded_at DESC)
    WHERE success = 0;
GO

;WITH nums AS (
    SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO metrics.wide_records (
    recorded_at, source, environment, service, region, host, pid, thread_id,
    user_id, session_id, request_id, trace_id, span_id, http_method,
    http_status, http_path, duration_ms, bytes_in, bytes_out, cpu_pct,
    mem_mb, queue_depth, retry_count, success, error_kind, error_message,
    tag_a, tag_b, tag_c, cost_cents, note
)
-- Same CHOOSE-re-evaluation hazard as above: materialize every random
-- pick once per row via CROSS APPLY (VALUES …) before referencing it.
SELECT
    DATEADD(MINUTE, -r.minutes_back, SYSUTCDATETIME()),
    CHOOSE(r.source_idx,    N'api', N'worker', N'cron', N'sidecar', N'batch'),
    CHOOSE(r.env_idx,       N'prod', N'staging', N'dev'),
    CHOOSE(r.service_idx,   N'orders', N'catalog', N'billing', N'search', N'auth', N'notifications'),
    CHOOSE(r.region_idx,    N'us-east-1', N'us-west-2', N'eu-west-1', N'ap-south-1'),
    N'host-' + RIGHT('00' + CAST(r.host_n AS NVARCHAR(2)), 2),
    r.pid,
    r.thread_id,
    N'user_' + CAST(r.user_n AS NVARCHAR(8)),
    NEWID(),
    NEWID(),
    LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2)),
    LOWER(CONVERT(NVARCHAR(16), CAST(NEWID() AS BINARY(8)), 2)),
    CHOOSE(r.method_idx,    N'GET', N'POST', N'PUT', N'DELETE', N'PATCH'),
    CHOOSE(r.status_idx,    200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 500, 502, 503),
    CHOOSE(r.path_idx,
           N'/api/orders', N'/api/orders/:id', N'/api/users/me',
           N'/api/products', N'/api/products/:sku', N'/api/checkout',
           N'/api/billing/invoices', N'/healthz', N'/api/search'),
    r.duration_ms,
    CAST(r.bytes_in AS BIGINT),
    CAST(r.bytes_out AS BIGINT),
    CAST(r.cpu AS FLOAT) / 100.0,
    CAST(r.mem AS FLOAT) / 10.0,
    r.queue_depth,
    r.retry_count,
    CASE WHEN r.success_roll < 85 THEN 1 ELSE 0 END,
    CASE WHEN r.err_present < 15
         THEN CHOOSE(r.err_idx,
                     N'Timeout', N'UpstreamError', N'ValidationError',
                     N'NotFound', N'RateLimited')
         ELSE NULL END,
    CASE WHEN r.errmsg_present < 15
         THEN N'unhandled exception at ' +
              LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2))
         ELSE NULL END,
    N'tier:'    + CHOOSE(r.tier_idx,    N'free', N'pro', N'enterprise'),
    N'team:'    + CHOOSE(r.team_idx,    N'alpha', N'beta', N'gamma', N'delta'),
    N'feature:' + CHOOSE(r.feature_idx, N'v1', N'v2', N'beta', N'dark'),
    r.cost_cents,
    CASE WHEN r.note_present < 30
         THEN N'arbitrary descriptive note ' +
              LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2))
         ELSE NULL END
FROM nums
CROSS APPLY (VALUES (
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % (60 * 24 * 7),
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 3  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 6  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 4  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 99 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 30000 + 1000,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 32 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5000 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 14 + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 9  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 1500 + 5,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 65536,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 524288,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 10000,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 40960,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 64,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 4,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 3  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 4  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 4  + 1,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 5000,
    (CHECKSUM(NEWID()) & 0x7FFFFFFF) % 100
)) AS r(
    minutes_back, source_idx, env_idx, service_idx, region_idx, host_n,
    pid, thread_id, user_n, method_idx, status_idx, path_idx,
    duration_ms, bytes_in, bytes_out, cpu, mem, queue_depth, retry_count,
    success_roll, err_present, err_idx, errmsg_present,
    tier_idx, team_idx, feature_idx, cost_cents, note_present
);
GO

-- Refresh stats so the planner has accurate selectivity for query
-- experiments later.
UPDATE STATISTICS shop.customers;
UPDATE STATISTICS shop.products;
UPDATE STATISTICS shop.orders;
UPDATE STATISTICS shop.order_items;
UPDATE STATISTICS shop.categories;
UPDATE STATISTICS shop.product_categories;
UPDATE STATISTICS shop.addresses;
UPDATE STATISTICS shop.shipments;
UPDATE STATISTICS shop.payments;
UPDATE STATISTICS shop.audit_log;
UPDATE STATISTICS metrics.events;
UPDATE STATISTICS metrics.wide_records;
GO
