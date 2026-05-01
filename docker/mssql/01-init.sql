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

;WITH actors(name) AS (
    SELECT v FROM (VALUES ('ada'),('grace'),('alan'),('linus'),('barbara')) AS x(v)
),
actions(name) AS (
    SELECT v FROM (VALUES ('login'),('search'),('purchase'),('logout'),('refund'),('signup')) AS x(v)
),
nums AS (
    SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO metrics.events (happened, actor, action, duration_ms)
SELECT
    DATEADD(MINUTE, -CAST(ABS(CHECKSUM(NEWID())) % (60 * 24 * 14) AS INT), SYSUTCDATETIME()),
    (SELECT TOP 1 name FROM actors  ORDER BY NEWID()),
    (SELECT TOP 1 name FROM actions ORDER BY NEWID()),
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
