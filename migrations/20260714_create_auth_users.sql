CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS travel_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(32) UNIQUE,
  password_hash TEXT NOT NULL,
  nickname VARCHAR(64),
  avatar_url TEXT,
  role VARCHAR(32) NOT NULL DEFAULT 'user',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_users_status_check CHECK (status IN ('active', 'disabled', 'locked')),
  CONSTRAINT travel_users_role_check CHECK (role IN ('user', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_travel_users_status ON travel_users(status);
CREATE INDEX IF NOT EXISTS idx_travel_users_created_at ON travel_users(created_at);

CREATE OR REPLACE FUNCTION set_travel_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_travel_users_updated_at ON travel_users;
CREATE TRIGGER trg_travel_users_updated_at
BEFORE UPDATE ON travel_users
FOR EACH ROW
EXECUTE FUNCTION set_travel_users_updated_at();
