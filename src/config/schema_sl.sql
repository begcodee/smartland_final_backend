-- SmartLand relational persistence (replaces app_snapshots blob).
DROP TABLE IF EXISTS app_snapshots CASCADE;

CREATE TABLE IF NOT EXISTS sl_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_parcels (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sl_users (id) ON DELETE CASCADE,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_conversations (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_payments (
  reference TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_transfers (
  id TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_ratings (
  id TEXT PRIMARY KEY,
  body JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sl_nia_employees (
  staff_id TEXT PRIMARY KEY,
  body JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sl_laws (
  id TEXT PRIMARY KEY,
  body JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sl_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  body JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sl_document_hashes (
  hash TEXT PRIMARY KEY,
  body JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sl_image_hashes (
  hash TEXT PRIMARY KEY,
  body JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sl_audit_logs (
  id TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  seq BIGSERIAL UNIQUE
);

CREATE TABLE IF NOT EXISTS sl_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_users_email ON sl_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_sl_parcels_seller ON sl_parcels (seller_id);
CREATE INDEX IF NOT EXISTS idx_sl_notifications_user ON sl_notifications (user_id);
