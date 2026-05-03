-- Durable application state for SmartLand (single-row JSON snapshot).
-- Safe to run repeatedly (no DROP). Use: npm run setup

CREATE TABLE IF NOT EXISTS app_snapshots (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_snapshots_updated ON app_snapshots (updated_at DESC);
