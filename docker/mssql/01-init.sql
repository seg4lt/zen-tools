-- Seed schema + data for the Database Explorer demo.
-- Idempotent: safe to re-run because the mssql-init sidecar applies it
-- on every `docker compose up` (mssql has no built-in entrypoint init dir).

IF DB_ID('zen_dev') IS NULL
BEGIN
    CREATE DATABASE zen_dev;
END
GO

USE zen_dev;
GO

-- ────────────────────────────────────────────────────────────────────────
-- "shop" schema
-- ────────────────────────────────────────────────────────────────────────
IF SCHEMA_ID('shop') IS NULL EXEC('CREATE SCHEMA shop');
GO

IF OBJECT_ID('shop.order_items', 'U') IS NOT NULL DROP TABLE shop.order_items;
IF OBJECT_ID('shop.orders',      'U') IS NOT NULL DROP TABLE shop.orders;
IF OBJECT_ID('shop.products',    'U') IS NOT NULL DROP TABLE shop.products;
IF OBJECT_ID('shop.customers',   'U') IS NOT NULL DROP TABLE shop.customers;
GO

CREATE TABLE shop.customers (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    full_name  NVARCHAR(255) NOT NULL,
    created_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE shop.products (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    sku         NVARCHAR(64)  NOT NULL UNIQUE,
    name        NVARCHAR(255) NOT NULL,
    price_cents INT           NOT NULL CHECK (price_cents >= 0),
    in_stock    BIT           NOT NULL DEFAULT 1
);

CREATE TABLE shop.orders (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    customer_id INT           NOT NULL REFERENCES shop.customers (id),
    placed_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    total_cents INT           NOT NULL CHECK (total_cents >= 0),
    status      NVARCHAR(16)  NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled'))
);

CREATE TABLE shop.order_items (
    order_id   INT NOT NULL REFERENCES shop.orders   (id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES shop.products (id),
    quantity   INT NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id)
);
GO

INSERT INTO shop.customers (email, full_name) VALUES
    ('ada@example.com',     'Ada Lovelace'),
    ('grace@example.com',   'Grace Hopper'),
    ('alan@example.com',    'Alan Turing'),
    ('linus@example.com',   'Linus Torvalds'),
    ('barbara@example.com', 'Barbara Liskov');

INSERT INTO shop.products (sku, name, price_cents, in_stock) VALUES
    ('KBD-001', 'Mechanical Keyboard', 12900, 1),
    ('MON-027', '27" 4K Monitor',      39900, 1),
    ('CHR-014', 'Ergonomic Chair',     54900, 1),
    ('CBL-006', 'USB-C Cable (1m)',      990, 1),
    ('LMP-003', 'Desk Lamp',            4990, 0);

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
GO

-- ────────────────────────────────────────────────────────────────────────
-- "metrics" schema — bigger table for the virtualised grid
-- ────────────────────────────────────────────────────────────────────────
IF SCHEMA_ID('metrics') IS NULL EXEC('CREATE SCHEMA metrics');
GO

IF OBJECT_ID('metrics.events', 'U') IS NOT NULL DROP TABLE metrics.events;
GO

CREATE TABLE metrics.events (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    happened    DATETIME2     NOT NULL,
    actor       NVARCHAR(64)  NOT NULL,
    action      NVARCHAR(64)  NOT NULL,
    duration_ms INT           NOT NULL
);
GO

-- 20k rows to exercise virtualised grid scroll performance.
;WITH nums AS (
    SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO metrics.events (happened, actor, action, duration_ms)
SELECT
    DATEADD(MINUTE, -CAST(ABS(CHECKSUM(NEWID())) % (60 * 24 * 14) AS INT), SYSUTCDATETIME()),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 5 + 1,
           N'ada', N'grace', N'alan', N'linus', N'barbara'),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 6 + 1,
           N'login', N'search', N'purchase', N'logout', N'refund', N'signup'),
    20 + ABS(CHECKSUM(NEWID())) % 800
FROM nums;
GO

CREATE INDEX events_happened_idx ON metrics.events (happened DESC);
GO

IF OBJECT_ID('metrics.daily_event_counts', 'V') IS NOT NULL
    DROP VIEW metrics.daily_event_counts;
GO
CREATE VIEW metrics.daily_event_counts AS
SELECT
    CAST(happened AS DATE) AS day,
    action,
    COUNT(*) AS n
FROM metrics.events
GROUP BY CAST(happened AS DATE), action;
GO

-- ────────────────────────────────────────────────────────────────────────
-- "metrics" : a wide telemetry table — 32 columns of mixed types so we
-- can exercise the results grid's *horizontal* scroll. 500 rows is
-- plenty since the focus here is column count, not row count.
-- ────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('metrics.wide_records', 'U') IS NOT NULL
    DROP TABLE metrics.wide_records;
GO

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
SELECT
    DATEADD(MINUTE, -CAST(ABS(CHECKSUM(NEWID())) % (60 * 24 * 7) AS INT), SYSUTCDATETIME()),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 5 + 1,
           N'api', N'worker', N'cron', N'sidecar', N'batch'),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 3 + 1, N'prod', N'staging', N'dev'),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 6 + 1,
           N'orders', N'catalog', N'billing', N'search', N'auth', N'notifications'),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 4 + 1,
           N'us-east-1', N'us-west-2', N'eu-west-1', N'ap-south-1'),
    N'host-' + RIGHT('00' + CAST(ABS(CHECKSUM(NEWID())) % 99 + 1 AS NVARCHAR(2)), 2),
    ABS(CHECKSUM(NEWID())) % 30000 + 1000,
    ABS(CHECKSUM(NEWID())) % 32 + 1,
    N'user_' + CAST(ABS(CHECKSUM(NEWID())) % 5000 + 1 AS NVARCHAR(8)),
    NEWID(),
    NEWID(),
    LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2)),
    LOWER(CONVERT(NVARCHAR(16), CAST(NEWID() AS BINARY(8)), 2)),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 5 + 1,
           N'GET', N'POST', N'PUT', N'DELETE', N'PATCH'),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 14 + 1,
           200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 500, 502, 503),
    CHOOSE(ABS(CHECKSUM(NEWID())) % 9 + 1,
           N'/api/orders', N'/api/orders/:id', N'/api/users/me',
           N'/api/products', N'/api/products/:sku', N'/api/checkout',
           N'/api/billing/invoices', N'/healthz', N'/api/search'),
    ABS(CHECKSUM(NEWID())) % 1500 + 5,
    CAST(ABS(CHECKSUM(NEWID())) % 65536 AS BIGINT),
    CAST(ABS(CHECKSUM(NEWID())) % 524288 AS BIGINT),
    CAST(ABS(CHECKSUM(NEWID())) % 10000 AS FLOAT) / 100.0,
    CAST(ABS(CHECKSUM(NEWID())) % 40960 AS FLOAT) / 10.0,
    ABS(CHECKSUM(NEWID())) % 64,
    ABS(CHECKSUM(NEWID())) % 4,
    CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 85 THEN 1 ELSE 0 END,
    CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 15
         THEN CHOOSE(ABS(CHECKSUM(NEWID())) % 5 + 1,
                     N'Timeout', N'UpstreamError', N'ValidationError',
                     N'NotFound', N'RateLimited')
         ELSE NULL END,
    CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 15
         THEN N'unhandled exception at ' +
              LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2))
         ELSE NULL END,
    N'tier:' + CHOOSE(ABS(CHECKSUM(NEWID())) % 3 + 1,
                      N'free', N'pro', N'enterprise'),
    N'team:' + CHOOSE(ABS(CHECKSUM(NEWID())) % 4 + 1,
                      N'alpha', N'beta', N'gamma', N'delta'),
    N'feature:' + CHOOSE(ABS(CHECKSUM(NEWID())) % 4 + 1,
                         N'v1', N'v2', N'beta', N'dark'),
    ABS(CHECKSUM(NEWID())) % 5000,
    CASE WHEN ABS(CHECKSUM(NEWID())) % 100 < 30
         THEN N'arbitrary descriptive note ' +
              LOWER(CONVERT(NVARCHAR(32), HASHBYTES('MD5', CAST(NEWID() AS NVARCHAR(36))), 2))
         ELSE NULL END
FROM nums;
GO

CREATE INDEX wide_recorded_at_idx ON metrics.wide_records (recorded_at DESC);
GO
