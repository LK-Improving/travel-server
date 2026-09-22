-- 通用 SaaS AI 能力基座：租户、应用、工具策略、Agent 运行和向量索引绑定。
-- 本迁移不复制现有向量、不创建 pgvector 扩展，也不修改 Milvus collection。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ai_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  app_key VARCHAR(128) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_applications_tenant ON ai_applications(tenant_id, status);

CREATE TABLE IF NOT EXISTS ai_memberships (
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES travel_users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_memberships_user ON ai_memberships(user_id, tenant_id);

CREATE TABLE IF NOT EXISTS ai_knowledge_base_bindings (
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  application_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL REFERENCES travel_knowledge_bases(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (knowledge_base_id),
  UNIQUE (tenant_id, knowledge_base_id),
  PRIMARY KEY (tenant_id, application_id, knowledge_base_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_bindings_application
  ON ai_knowledge_base_bindings(application_id, tenant_id);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  application_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  thread_id VARCHAR(160) NOT NULL,
  graph_name VARCHAR(80) NOT NULL,
  graph_version VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued', 'running', 'interrupted', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_code VARCHAR(80),
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_tenant_started
  ON ai_agent_runs(tenant_id, application_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_thread
  ON ai_agent_runs(thread_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_tool_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  application_id UUID NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  tool_name VARCHAR(120) NOT NULL,
  effect VARCHAR(8) NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, application_id, role, tool_name, effect)
);
CREATE INDEX IF NOT EXISTS idx_ai_tool_policies_lookup
  ON ai_tool_policies(tenant_id, application_id, role, tool_name);

CREATE TABLE IF NOT EXISTS ai_vector_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  knowledge_base_id UUID NOT NULL,
  backend VARCHAR(16) NOT NULL CHECK (backend IN ('milvus', 'pgvector')),
  collection_name VARCHAR(255) NOT NULL,
  embedding_model VARCHAR(255) NOT NULL,
  embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
  distance_metric VARCHAR(16) NOT NULL CHECK (distance_metric IN ('cosine', 'l2', 'ip')),
  index_version INTEGER NOT NULL DEFAULT 1 CHECK (index_version > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'active', 'failed', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES ai_knowledge_base_bindings(tenant_id, knowledge_base_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_vector_indexes_tenant_kb
  ON ai_vector_indexes(tenant_id, knowledge_base_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_vector_indexes_active_kb
  ON ai_vector_indexes(knowledge_base_id)
  WHERE status = 'active';
