-- 评测运行按稀疏检索后端打标，便于 pg_trgm → elasticsearch 切换前后做指标对比。
ALTER TABLE ai_eval_runs ADD COLUMN IF NOT EXISTS sparse_backend VARCHAR(20);

-- 历史运行均处于 pg_trgm 默认后端（切换前从未启用 ab / elasticsearch），回填打标。
-- 仅回填 NULL 行，后续运行由应用显式写入实际后端，不受影响。
UPDATE ai_eval_runs SET sparse_backend = 'pg_trgm' WHERE sparse_backend IS NULL;
