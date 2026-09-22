-- 杭州旅游 AI 助手一期：可重复执行的非破坏性升级。
-- 本迁移不创建 pgvector 扩展，也不保存向量；向量只写入 Milvus。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_travel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE IF EXISTS travel_users DROP CONSTRAINT IF EXISTS travel_users_role_check;
ALTER TABLE IF EXISTS travel_users
  ADD CONSTRAINT travel_users_role_check
  CHECK (role IN ('user', 'viewer', 'operator', 'admin')) NOT VALID;

CREATE TABLE IF NOT EXISTS travel_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key VARCHAR(128) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS travel_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES travel_users(id) ON DELETE CASCADE,
  owner_client_id UUID REFERENCES travel_clients(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL DEFAULT '新对话',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_conversations_owner_check CHECK (
    (owner_user_id IS NOT NULL)::INTEGER + (owner_client_id IS NOT NULL)::INTEGER = 1
  ),
  CONSTRAINT travel_conversations_status_check CHECK (status IN ('active', 'deleted'))
);
CREATE INDEX IF NOT EXISTS idx_travel_conversations_user_updated ON travel_conversations(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_conversations_client_updated ON travel_conversations(owner_client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS travel_conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES travel_conversations(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivery_status VARCHAR(16) NOT NULL DEFAULT 'complete',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_conversation_messages_role_check CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  CONSTRAINT travel_conversation_messages_delivery_check CHECK (delivery_status IN ('processing', 'complete', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_travel_messages_conversation_created ON travel_conversation_messages(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS travel_conversation_summaries (
  conversation_id UUID PRIMARY KEY REFERENCES travel_conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS travel_user_preferences (
  owner_key VARCHAR(160) PRIMARY KEY,
  owner_type VARCHAR(16) NOT NULL CHECK (owner_type IN ('user', 'client')),
  owner_id VARCHAR(128) NOT NULL,
  regions TEXT[] NOT NULL DEFAULT '{}',
  budget_range VARCHAR(16),
  party_size VARCHAR(16),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_preferences_regions_check CHECK (cardinality(regions) <= 3),
  CONSTRAINT travel_preferences_region_values_check CHECK (regions <@ ARRAY['上城','拱墅','西湖','滨江','萧山','余杭','临平','钱塘','富阳','临安','建德','桐庐','淳安']::TEXT[]),
  CONSTRAINT travel_preferences_budget_check CHECK (budget_range IS NULL OR budget_range IN ('under500', 'from500To1000', 'from1000To2000', 'from2000To5000', 'over5000')),
  CONSTRAINT travel_preferences_party_check CHECK (party_size IS NULL OR party_size IN ('solo', 'couple', 'family', 'group')),
  UNIQUE(owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS travel_knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by UUID REFERENCES travel_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS travel_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES travel_knowledge_bases(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  object_key TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  regions TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_by UUID REFERENCES travel_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_documents_status_check CHECK (status IN ('draft', 'processing', 'failed', 'ready', 'published', 'offline')),
  CONSTRAINT travel_documents_regions_check CHECK (cardinality(regions) <= 3),
  CONSTRAINT travel_documents_region_values_check CHECK (regions <@ ARRAY['上城','拱墅','西湖','滨江','萧山','余杭','临平','钱塘','富阳','临安','建德','桐庐','淳安']::TEXT[]),
  UNIQUE(knowledge_base_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_travel_documents_kb_status ON travel_documents(knowledge_base_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS travel_document_chunks (
  chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES travel_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  section VARCHAR(255),
  page INTEGER CHECK (page IS NULL OR page > 0),
  content TEXT NOT NULL,
  regions TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  embedding_model VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_chunks_region_values_check CHECK (regions <@ ARRAY['上城','拱墅','西湖','滨江','萧山','余杭','临平','钱塘','富阳','临安','建德','桐庐','淳安']::TEXT[]),
  UNIQUE(document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_travel_chunks_document_index ON travel_document_chunks(document_id, chunk_index);

CREATE TABLE IF NOT EXISTS travel_suggested_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content VARCHAR(500) NOT NULL,
  regions TEXT[] NOT NULL DEFAULT '{}',
  budget_ranges TEXT[] NOT NULL DEFAULT '{}',
  party_sizes TEXT[] NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES travel_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT travel_questions_regions_check CHECK (cardinality(regions) <= 3),
  CONSTRAINT travel_questions_region_values_check CHECK (regions <@ ARRAY['上城','拱墅','西湖','滨江','萧山','余杭','临平','钱塘','富阳','临安','建德','桐庐','淳安']::TEXT[]),
  CONSTRAINT travel_questions_budget_values_check CHECK (budget_ranges <@ ARRAY['under500','from500To1000','from1000To2000','from2000To5000','over5000']::TEXT[]),
  CONSTRAINT travel_questions_party_values_check CHECK (party_sizes <@ ARRAY['solo','couple','family','group']::TEXT[])
);
CREATE INDEX IF NOT EXISTS idx_travel_questions_enabled_sort ON travel_suggested_questions(enabled, sort_order, created_at);

-- Upgrade existing phase-one databases from the retired three-tier budget enum.
ALTER TABLE IF EXISTS travel_user_preferences DROP CONSTRAINT IF EXISTS travel_preferences_budget_check;
ALTER TABLE IF EXISTS travel_suggested_questions DROP CONSTRAINT IF EXISTS travel_questions_budget_values_check;

UPDATE travel_user_preferences
SET budget_range = CASE budget_range
  WHEN 'economy' THEN 'under500'
  WHEN 'comfortable' THEN 'from1000To2000'
  WHEN 'premium' THEN 'over5000'
  ELSE budget_range
END
WHERE budget_range IN ('economy', 'comfortable', 'premium');

UPDATE travel_suggested_questions
SET budget_ranges = ARRAY(
  SELECT CASE item.value
    WHEN 'economy' THEN 'under500'
    WHEN 'comfortable' THEN 'from1000To2000'
    WHEN 'premium' THEN 'over5000'
    ELSE item.value
  END
  FROM unnest(budget_ranges) WITH ORDINALITY AS item(value, position)
  ORDER BY item.position
)
WHERE budget_ranges && ARRAY['economy', 'comfortable', 'premium']::TEXT[];

ALTER TABLE IF EXISTS travel_user_preferences
  ADD CONSTRAINT travel_preferences_budget_check
  CHECK (budget_range IS NULL OR budget_range IN ('under500', 'from500To1000', 'from1000To2000', 'from2000To5000', 'over5000'));
ALTER TABLE IF EXISTS travel_suggested_questions
  ADD CONSTRAINT travel_questions_budget_values_check
  CHECK (budget_ranges <@ ARRAY['under500','from500To1000','from1000To2000','from2000To5000','over5000']::TEXT[]);

CREATE TABLE IF NOT EXISTS travel_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES travel_conversations(id) ON DELETE SET NULL,
  actor_key VARCHAR(160),
  tool_name VARCHAR(80) NOT NULL,
  arguments_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'timeout')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_tool_calls_conversation_created ON travel_tool_calls(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS travel_admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES travel_users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(80) NOT NULL,
  target_id VARCHAR(128),
  status VARCHAR(16) NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_admin_audit_created ON travel_admin_audit_logs(created_at DESC, id);

CREATE TABLE IF NOT EXISTS travel_audit_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_method VARCHAR(40) NOT NULL CHECK (event_method IN ('audit', 'record_tool_call')),
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error VARCHAR(160),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_audit_outbox_pending
  ON travel_audit_outbox(status, next_attempt_at, id)
  WHERE status='pending';

DROP TRIGGER IF EXISTS trg_travel_conversations_updated_at ON travel_conversations;
CREATE TRIGGER trg_travel_conversations_updated_at BEFORE UPDATE ON travel_conversations FOR EACH ROW EXECUTE FUNCTION set_travel_updated_at();
DROP TRIGGER IF EXISTS trg_travel_knowledge_bases_updated_at ON travel_knowledge_bases;
CREATE TRIGGER trg_travel_knowledge_bases_updated_at BEFORE UPDATE ON travel_knowledge_bases FOR EACH ROW EXECUTE FUNCTION set_travel_updated_at();
DROP TRIGGER IF EXISTS trg_travel_documents_updated_at ON travel_documents;
CREATE TRIGGER trg_travel_documents_updated_at BEFORE UPDATE ON travel_documents FOR EACH ROW EXECUTE FUNCTION set_travel_updated_at();
DROP TRIGGER IF EXISTS trg_travel_suggested_questions_updated_at ON travel_suggested_questions;
CREATE TRIGGER trg_travel_suggested_questions_updated_at BEFORE UPDATE ON travel_suggested_questions FOR EACH ROW EXECUTE FUNCTION set_travel_updated_at();
