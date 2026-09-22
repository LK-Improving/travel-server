-- P1 evaluation evidence: preserve the run snapshot and store per-case diagnostics.
ALTER TABLE ai_eval_runs ADD COLUMN IF NOT EXISTS evaluator_version VARCHAR(40) NOT NULL DEFAULT '1.0';

ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS question TEXT;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS answer_text TEXT;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS cited_source_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS tool_args_valid BOOLEAN;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS format_valid BOOLEAN;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS budget_valid BOOLEAN;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS safety_passed BOOLEAN;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS tenant_isolation_passed BOOLEAN;
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS estimated_cost_cny NUMERIC(18, 6);
ALTER TABLE ai_eval_results ADD COLUMN IF NOT EXISTS judge JSONB NOT NULL DEFAULT '{}'::jsonb;
