CREATE TABLE IF NOT EXISTS travel_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES travel_users(id) ON DELETE CASCADE,
  target_type VARCHAR(32) NOT NULL DEFAULT 'travel_plan',
  target_id TEXT,
  title VARCHAR(120) NOT NULL,
  content TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_travel_favorites_user_created_at
  ON travel_favorites(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_favorites_unique_target
  ON travel_favorites(user_id, target_type, target_id)
  WHERE target_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_travel_favorites_updated_at ON travel_favorites;
CREATE TRIGGER trg_travel_favorites_updated_at
BEFORE UPDATE ON travel_favorites
FOR EACH ROW
EXECUTE FUNCTION set_travel_users_updated_at();

CREATE TABLE IF NOT EXISTS travel_user_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES travel_users(id) ON DELETE CASCADE,
  conversation_id VARCHAR(64) NOT NULL DEFAULT 'default',
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_user_memories_role_check CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_travel_user_memories_user_conversation_created_at
  ON travel_user_memories(user_id, conversation_id, created_at DESC);
