-- P3 agent governance: routing, usage, trace and approval evidence.
-- This migration is additive and must be executed explicitly after prior migrations.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS trace_id VARCHAR(80);
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS intent VARCHAR(40);
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS model_routes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS model_usage JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS skill_versions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0);
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0);
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0);
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS estimated_cost_cny NUMERIC(18, 6);
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_trace ON ai_agent_runs(trace_id);

ALTER TABLE ai_tool_policies ADD COLUMN IF NOT EXISTS requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS model_routes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS model_usage JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS skill_versions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS ai_tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES ai_tenants(id) ON DELETE CASCADE,
  application_id UUID NOT NULL,
  actor_id UUID NOT NULL REFERENCES travel_users(id) ON DELETE CASCADE,
  conversation_id UUID,
  tool_name VARCHAR(120) NOT NULL,
  arguments_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES travel_users(id) ON DELETE SET NULL,
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES ai_applications(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_tool_approvals_lookup
  ON ai_tool_approvals(tenant_id, application_id, actor_id, status, expires_at);
