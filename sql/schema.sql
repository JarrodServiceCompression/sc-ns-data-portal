-- schema.sql — one table for the NetSuite asset saved search.
-- Snapshot-append model: every load stamps loaded_at; we never truncate-and-replace.
-- Columns are a pragmatic subset of the asset search; raw_payload keeps the full row
-- so we never lose a field we didn't model yet.

IF OBJECT_ID('dbo.assets', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.assets (
        row_id        BIGINT IDENTITY(1,1) PRIMARY KEY,
        unit_name     NVARCHAR(64)   NULL,   -- asset/unit number, e.g. "2131"
        status        NVARCHAR(128)  NULL,   -- coerced from NetSuite {value,text} -> text
        region        NVARCHAR(128)  NULL,
        customer      NVARCHAR(256)  NULL,
        engine_make   NVARCHAR(128)  NULL,
        engine_model  NVARCHAR(128)  NULL,
        horsepower    NVARCHAR(64)   NULL,
        driver_type   NVARCHAR(64)   NULL,   -- gas / electric
        pm_cycle_days NVARCHAR(32)   NULL,   -- 45 or 90
        raw_payload   NVARCHAR(MAX)  NULL,   -- full source row as JSON (nothing lost)
        loaded_at     DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME()
    );

    CREATE INDEX ix_assets_loaded_at ON dbo.assets (loaded_at DESC);
    CREATE INDEX ix_assets_status    ON dbo.assets (status);
END;
GO

-- Prove it's real and empty before we load:
SELECT COUNT(*) AS row_count, MAX(loaded_at) AS latest_snapshot FROM dbo.assets;
