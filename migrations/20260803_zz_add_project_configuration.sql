-- Project configuration is versioned; this migration only adds new schema.
ALTER TABLE ai_applications ADD COLUMN IF NOT EXISTS public_id VARCHAR(72);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_applications_public_id
  ON ai_applications(public_id) WHERE public_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_project_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ai_applications(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status VARCHAR(16) NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  display_config JSONB NOT NULL,
  system_prompt TEXT NOT NULL,
  model_key VARCHAR(160) NOT NULL,
  temperature NUMERIC(3,2) NOT NULL CHECK (temperature >= 0 AND temperature <= 2),
  max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 128 AND 8192),
  feature_flags JSONB NOT NULL,
  created_by UUID REFERENCES travel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  CONSTRAINT uq_ai_project_versions_project_version UNIQUE (project_id, version),
  CONSTRAINT uq_ai_project_versions_id_project UNIQUE (id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_project_versions_published
  ON ai_project_versions(project_id) WHERE status = 'published';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_ai_project_versions_id_project') THEN
    ALTER TABLE ai_project_versions
      ADD CONSTRAINT uq_ai_project_versions_id_project UNIQUE (id, project_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS ai_tenant_knowledge_bases (
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES travel_knowledge_bases(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_ai_tenant_knowledge_bases PRIMARY KEY (tenant_id, knowledge_base_id),
  CONSTRAINT uq_ai_tenant_knowledge_bases_knowledge_base UNIQUE (knowledge_base_id)
);
INSERT INTO ai_tenant_knowledge_bases (tenant_id, knowledge_base_id)
SELECT DISTINCT tenant_id, knowledge_base_id
FROM ai_knowledge_base_bindings
ON CONFLICT (tenant_id, knowledge_base_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_project_version_knowledge_bases (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  project_version_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_ai_project_version_knowledge_bases PRIMARY KEY (project_version_id, knowledge_base_id),
  CONSTRAINT uq_ai_project_version_knowledge_bases UNIQUE (project_version_id, knowledge_base_id),
  CONSTRAINT fk_ai_project_version_kbs_version_project
    FOREIGN KEY (project_version_id, project_id)
    REFERENCES ai_project_versions(id, project_id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_project_version_kbs_project_tenant
    FOREIGN KEY (project_id, tenant_id)
    REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_project_version_kbs_tenant_kb
    FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES ai_tenant_knowledge_bases(tenant_id, knowledge_base_id) ON DELETE CASCADE
);
ALTER TABLE ai_project_version_knowledge_bases ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE ai_project_version_knowledge_bases ADD COLUMN IF NOT EXISTS project_id UUID;
UPDATE ai_project_version_knowledge_bases AS link
SET project_id = version.project_id,
    tenant_id = application.tenant_id
FROM ai_project_versions AS version
JOIN ai_applications AS application ON application.id = version.project_id
WHERE link.project_version_id = version.id
  AND (link.project_id IS NULL OR link.tenant_id IS NULL);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'ai_project_version_knowledge_bases'::regclass
      AND attname = 'tenant_id' AND NOT attnotnull
  ) THEN
    ALTER TABLE ai_project_version_knowledge_bases ALTER COLUMN tenant_id SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'ai_project_version_knowledge_bases'::regclass
      AND attname = 'project_id' AND NOT attnotnull
  ) THEN
    ALTER TABLE ai_project_version_knowledge_bases ALTER COLUMN project_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_project_version_kbs_version_project') THEN
    ALTER TABLE ai_project_version_knowledge_bases
      ADD CONSTRAINT fk_ai_project_version_kbs_version_project
      FOREIGN KEY (project_version_id, project_id)
      REFERENCES ai_project_versions(id, project_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_project_version_kbs_project_tenant') THEN
    ALTER TABLE ai_project_version_knowledge_bases
      ADD CONSTRAINT fk_ai_project_version_kbs_project_tenant
      FOREIGN KEY (project_id, tenant_id)
      REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_project_version_kbs_tenant_project_kb') THEN
    ALTER TABLE ai_project_version_knowledge_bases
      DROP CONSTRAINT fk_ai_project_version_kbs_tenant_project_kb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_project_version_kbs_tenant_kb') THEN
    ALTER TABLE ai_project_version_knowledge_bases
      ADD CONSTRAINT fk_ai_project_version_kbs_tenant_kb
      FOREIGN KEY (tenant_id, knowledge_base_id)
      REFERENCES ai_tenant_knowledge_bases(tenant_id, knowledge_base_id) ON DELETE CASCADE;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_ai_project_version_kbs_knowledge_base
  ON ai_project_version_knowledge_bases(knowledge_base_id, project_version_id);

CREATE TABLE IF NOT EXISTS ai_project_test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ai_applications(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  expected_answer TEXT,
  created_by UUID REFERENCES travel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_project_test_cases_project
  ON ai_project_test_cases(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_project_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES ai_applications(id) ON DELETE CASCADE,
  project_version_id UUID NOT NULL REFERENCES ai_project_versions(id) ON DELETE CASCADE,
  test_case_id UUID REFERENCES ai_project_test_cases(id) ON DELETE SET NULL,
  request_text TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  cited_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  passed BOOLEAN,
  created_by UUID REFERENCES travel_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_project_test_runs_version
  ON ai_project_test_runs(project_version_id, created_at DESC);

ALTER TABLE travel_conversations ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE travel_conversations ADD COLUMN IF NOT EXISTS project_version_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'travel_conversations_project_version_project_fkey') THEN
    ALTER TABLE travel_conversations
      ADD CONSTRAINT travel_conversations_project_version_project_fkey
      FOREIGN KEY (project_version_id, project_id)
      REFERENCES ai_project_versions(id, project_id) MATCH FULL ON DELETE SET NULL;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_travel_conversations_project_owner_updated
  ON travel_conversations(project_id, owner_user_id, owner_client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_message_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES travel_conversation_messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES travel_users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES travel_clients(id) ON DELETE CASCADE,
  value VARCHAR(4) NOT NULL CHECK (value IN ('up', 'down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_message_feedback_owner_check CHECK (
    (user_id IS NOT NULL)::INTEGER + (client_id IS NOT NULL)::INTEGER = 1
  ),
  UNIQUE (message_id, user_id),
  UNIQUE (message_id, client_id)
);
