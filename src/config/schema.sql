-- Drop existing tables if they exist (in reverse dependency order)
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS land_transfers CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS lands CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Create users table first (required for foreign keys)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone_number VARCHAR(50),
  role VARCHAR(50) NOT NULL DEFAULT 'buyer',
  password_hash TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  nia_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  nia_reference_id VARCHAR(100),
  nia_verified_at TIMESTAMP,
  id_verification JSONB,
  national_id VARCHAR(50) UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create lands table
CREATE TABLE IF NOT EXISTS lands (
  id SERIAL PRIMARY KEY,
  land_name VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  size VARCHAR(100), -- flexible display size (e.g., '0.25 acre')
  coordinates JSONB, -- Store lat/lng or polygon coordinates
  boundary_polygon JSONB,
  geo_fingerprint_hash VARCHAR(80),
  conflict_risk VARCHAR(20) NOT NULL DEFAULT 'medium',
  locked_until TIMESTAMP,
  owner_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  price_ghs NUMERIC(12,2) NOT NULL DEFAULT 0,
  land_type VARCHAR(100), -- e.g., 'residential', 'commercial', 'agricultural'
  description TEXT,
  blockchain_hash VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Payments (Paystack)
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  reference VARCHAR(120) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  parcel_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  amount_pesewas INTEGER NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'GHS',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMP,
  FOREIGN KEY (parcel_id) REFERENCES lands(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Conversations & messages (buyer ↔ seller per parcel)
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  parcel_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(parcel_id, buyer_id, seller_id),
  FOREIGN KEY (parcel_id) REFERENCES lands(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create land_transfers table for audit trail + chain anchoring fields
CREATE TABLE IF NOT EXISTS land_transfers (
  id SERIAL PRIMARY KEY,
  land_id INTEGER NOT NULL,
  from_owner_id INTEGER NOT NULL,
  to_owner_id INTEGER NOT NULL,
  paystack_reference VARCHAR(120),
  chain_tx_hash VARCHAR(120),
  chain_network VARCHAR(50),
  chain_sale_id VARCHAR(120),
  chain_anchored_at TIMESTAMP,
  transfer_reason TEXT,
  transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (land_id) REFERENCES lands(id) ON DELETE CASCADE,
  FOREIGN KEY (from_owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (to_owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit trail (security + investigations)
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event VARCHAR(120) NOT NULL,
  actor_user_id INTEGER,
  ip VARCHAR(80),
  user_agent TEXT,
  details JSONB,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_lands_owner_id ON lands(owner_id);
CREATE INDEX IF NOT EXISTS idx_lands_location ON lands(location);
CREATE INDEX IF NOT EXISTS idx_lands_status ON lands(status);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_conversations_parcel ON conversations(parcel_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_land_transfers_land_id ON land_transfers(land_id);
CREATE INDEX IF NOT EXISTS idx_land_transfers_from_owner ON land_transfers(from_owner_id);
CREATE INDEX IF NOT EXISTS idx_land_transfers_to_owner ON land_transfers(to_owner_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
