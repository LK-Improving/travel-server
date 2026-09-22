-- Prompt/model/knowledge-base regression tracking. Metrics are immutable run snapshots.
CREATE TABLE IF NOT EXISTS ai_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_version VARCHAR(120) NOT NULL,
  dataset_sha256 CHAR(64) NOT NULL,
  prompt_version VARCHAR(120) NOT NULL,
  model_version VARCHAR(255) NOT NULL,
  embedding_model_version VARCHAR(255) NOT NULL,
  reranker_version VARCHAR(255),
  knowledge_base_snapshot VARCHAR(255) NOT NULL,
  retrieval_version VARCHAR(120) NOT NULL,
  git_revision VARCHAR(80),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_eval_runs_created ON ai_eval_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_eval_results (
  run_id UUID NOT NULL REFERENCES ai_eval_runs(id) ON DELETE CASCADE,
  case_id VARCHAR(120) NOT NULL,
  intent VARCHAR(80),
  route VARCHAR(120),
  retrieved_source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_fact_pass BOOLEAN,
  abstained BOOLEAN,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  passed BOOLEAN NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, case_id)
);
