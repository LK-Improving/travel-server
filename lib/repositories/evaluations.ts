/**
 * 评测中心数据访问：不可变运行快照 + 逐用例证据。
 * 对应 Python 版 repositories/postgres.py 的评测域方法。
 */
import { execute, query, queryOne, toJsonList, toJsonObject } from '../db/pool';
import { config } from '../config';

export interface EvalManifest {
  datasetVersion?: string;
  datasetSha256?: string;
  promptVersion?: string;
  modelVersion?: string;
  embeddingModelVersion?: string;
  rerankerVersion?: string | null;
  knowledgeBaseSnapshot?: string;
  retrievalVersion?: string;
  gitRevision?: string | null;
  evaluatorVersion?: string;
  metrics?: Record<string, unknown>;
  /** 稀疏检索后端（pg_trgm / elasticsearch），用于切换前后评测指标对比；缺省取当前生效后端。 */
  sparseBackend?: string;
}

export interface EvalRunSummary {
  runId: string;
  datasetVersion: string;
  promptVersion: string;
  modelVersion: string;
  embeddingModelVersion: string;
  rerankerVersion: string | null;
  knowledgeBaseSnapshot: string;
  evaluatorVersion: string;
  metrics: Record<string, unknown>;
  status: string;
  createdAt: string | null;
  sparseBackend: string | null;
}

export interface EvalResultRow {
  caseId: string;
  question: string;
  intent: string | null;
  route: string | null;
  retrievedSourceIds: unknown[];
  requiredFactPass: boolean | null;
  abstained: boolean | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  answer: string;
  citedSourceIds: unknown[];
  toolCalls: unknown[];
  modelRoutes: unknown[];
  modelUsage: unknown[];
  skillVersions: unknown[];
  toolArgsValid: boolean | null;
  formatValid: boolean | null;
  budgetValid: boolean | null;
  safetyPassed: boolean | null;
  tenantIsolationPassed: boolean | null;
  estimatedCostCny: string | null;
  judge: Record<string, unknown>;
  passed: boolean | null;
  details: Record<string, unknown>;
}

export interface EvalRunDetail extends EvalRunSummary {
  datasetSha256: string;
  retrievalVersion: string;
  gitRevision: string | null;
  results: EvalResultRow[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function createEvalRun(
  manifest: EvalManifest,
  status: 'running' | 'completed' | 'failed' = 'completed',
): Promise<string> {
  if (!['running', 'completed', 'failed'].includes(status)) throw new Error('评测运行状态无效');
  const sparseBackend = String(manifest.sparseBackend ?? config.ragSparseBackend);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO ai_eval_runs
       (dataset_version,dataset_sha256,prompt_version,model_version,embedding_model_version,
        reranker_version,knowledge_base_snapshot,retrieval_version,git_revision,
        evaluator_version,metrics,status,sparse_backend)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     RETURNING id`,
    [
      String(manifest.datasetVersion ?? 'unknown'),
      String(manifest.datasetSha256 ?? ''),
      String(manifest.promptVersion ?? 'unknown'),
      String(manifest.modelVersion ?? 'unknown'),
      String(manifest.embeddingModelVersion ?? 'unknown'),
      manifest.rerankerVersion ?? null,
      String(manifest.knowledgeBaseSnapshot ?? 'unknown'),
      String(manifest.retrievalVersion ?? 'unknown'),
      manifest.gitRevision ?? null,
      String(manifest.evaluatorVersion ?? '2.0'),
      JSON.stringify(manifest.metrics ?? {}),
      status,
      sparseBackend,
    ],
  );
  return String(row!.id);
}

export async function finishEvalRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
  if (!['completed', 'failed'].includes(status)) throw new Error('评测运行终态无效');
  await execute("UPDATE ai_eval_runs SET status=$2 WHERE id=$1 AND status='running'", [runId, status]);
}

/** 保存逐用例证据；(run_id, case_id) 冲突时忽略，保证运行快照不可变。 */
export async function saveEvalResult(options: {
  runId: string;
  caseId: string;
  question: string;
  result: Record<string, unknown>;
  detail: Record<string, unknown>;
}): Promise<void> {
  const { result, detail } = options;
  const latency = result.latencyMs;
  await execute(
    `INSERT INTO ai_eval_results
       (run_id,case_id,question,intent,route,retrieved_source_ids,required_fact_pass,
        abstained,latency_ms,input_tokens,output_tokens,answer_text,cited_source_ids,
        tool_calls,model_routes,model_usage,skill_versions,tool_args_valid,format_valid,budget_valid,safety_passed,
        tenant_isolation_passed,estimated_cost_cny,judge,passed,details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
             $15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26::jsonb)
     ON CONFLICT (run_id,case_id) DO NOTHING`,
    [
      options.runId,
      options.caseId,
      options.question,
      result.intent ?? null,
      result.route ?? null,
      JSON.stringify(result.retrievedSourceIds ?? []),
      detail.requiredFactPass ?? null,
      result.abstained ?? null,
      latency !== null && latency !== undefined ? Math.trunc(Number(latency)) : null,
      result.inputTokens ?? null,
      result.outputTokens ?? null,
      String(result.answer ?? ''),
      JSON.stringify(result.citedSourceIds ?? []),
      JSON.stringify(result.toolCalls ?? []),
      JSON.stringify(result.modelRoutes ?? []),
      JSON.stringify(result.modelUsage ?? []),
      JSON.stringify(result.skillVersions ?? []),
      result.toolArgsValid ?? null,
      result.formatValid ?? null,
      result.budgetValid ?? null,
      result.safetyPassed ?? null,
      result.tenantIsolationPassed ?? null,
      result.estimatedCostCny ?? null,
      JSON.stringify(result.judge ?? {}),
      Boolean(detail.passed),
      JSON.stringify(detail),
    ],
  );
}

export async function listEvalRuns(
  limit: number,
  offset: number,
  sparseBackend?: string | null,
): Promise<EvalRunSummary[]> {
  const filters: unknown[] = [];
  let where = '';
  if (sparseBackend) {
    where = ' WHERE sparse_backend = $3';
    filters.push(sparseBackend);
  }
  const rows = await query<{
    id: string;
    dataset_version: string;
    prompt_version: string;
    model_version: string;
    embedding_model_version: string;
    reranker_version: string | null;
    knowledge_base_snapshot: string;
    evaluator_version: string;
    metrics: unknown;
    status: string;
    created_at: string;
    sparse_backend: string | null;
  }>(
    `SELECT id,dataset_version,prompt_version,model_version,embedding_model_version,
            reranker_version,knowledge_base_snapshot,evaluator_version,metrics,status,created_at,sparse_backend
     FROM ai_eval_runs${where} ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
    [clamp(Math.trunc(limit), 1, 100), Math.max(Math.trunc(offset), 0), ...filters],
  );
  return rows.map((row) => ({
    runId: String(row.id),
    datasetVersion: row.dataset_version,
    promptVersion: row.prompt_version,
    modelVersion: row.model_version,
    embeddingModelVersion: row.embedding_model_version,
    rerankerVersion: row.reranker_version,
    knowledgeBaseSnapshot: row.knowledge_base_snapshot,
    evaluatorVersion: row.evaluator_version,
    metrics: toJsonObject(row.metrics),
    status: row.status,
    createdAt: row.created_at,
    sparseBackend: row.sparse_backend,
  }));
}

/** 取某稀疏后端最近一次「已完成」的评测运行，用于切换前后指标对比。 */
export async function getLatestRunBySparseBackend(backend: string): Promise<EvalRunSummary | null> {
  const rows = await query<{
    id: string;
    dataset_version: string;
    prompt_version: string;
    model_version: string;
    embedding_model_version: string;
    reranker_version: string | null;
    knowledge_base_snapshot: string;
    evaluator_version: string;
    metrics: unknown;
    status: string;
    created_at: string;
    sparse_backend: string | null;
  }>(
    `SELECT id,dataset_version,prompt_version,model_version,embedding_model_version,
            reranker_version,knowledge_base_snapshot,evaluator_version,metrics,status,created_at,sparse_backend
     FROM ai_eval_runs WHERE sparse_backend=$1 AND status='completed'
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [backend],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    runId: String(row.id),
    datasetVersion: row.dataset_version,
    promptVersion: row.prompt_version,
    modelVersion: row.model_version,
    embeddingModelVersion: row.embedding_model_version,
    rerankerVersion: row.reranker_version,
    knowledgeBaseSnapshot: row.knowledge_base_snapshot,
    evaluatorVersion: row.evaluator_version,
    metrics: toJsonObject(row.metrics),
    status: row.status,
    createdAt: row.created_at,
    sparseBackend: row.sparse_backend,
  };
}

export async function getEvalRun(runId: string): Promise<EvalRunDetail | null> {
  const run = await queryOne<{
    id: string;
    dataset_version: string;
    dataset_sha256: string;
    prompt_version: string;
    model_version: string;
    embedding_model_version: string;
    reranker_version: string | null;
    knowledge_base_snapshot: string;
    retrieval_version: string;
    git_revision: string | null;
    evaluator_version: string;
    metrics: unknown;
    status: string;
    created_at: string;
    sparse_backend: string | null;
  }>(
    `SELECT id,dataset_version,dataset_sha256,prompt_version,model_version,embedding_model_version,
            reranker_version,knowledge_base_snapshot,retrieval_version,git_revision,evaluator_version,
            metrics,status,created_at,sparse_backend FROM ai_eval_runs WHERE id=$1`,
    [runId],
  );
  if (!run) return null;

  const rows = await query<{
    case_id: string;
    question: string;
    intent: string | null;
    route: string | null;
    retrieved_source_ids: unknown;
    required_fact_pass: boolean | null;
    abstained: boolean | null;
    latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    answer_text: string;
    cited_source_ids: unknown;
    tool_calls: unknown;
    model_routes: unknown;
    model_usage: unknown;
    skill_versions: unknown;
    tool_args_valid: boolean | null;
    format_valid: boolean | null;
    budget_valid: boolean | null;
    safety_passed: boolean | null;
    tenant_isolation_passed: boolean | null;
    estimated_cost_cny: string | null;
    judge: unknown;
    passed: boolean | null;
    details: unknown;
  }>(
    `SELECT case_id,question,intent,route,retrieved_source_ids,required_fact_pass,abstained,
            latency_ms,input_tokens,output_tokens,answer_text,cited_source_ids,tool_calls,
            model_routes,model_usage,skill_versions,
            tool_args_valid,format_valid,budget_valid,safety_passed,tenant_isolation_passed,
            estimated_cost_cny,judge,passed,details
     FROM ai_eval_results WHERE run_id=$1 ORDER BY case_id`,
    [runId],
  );

  return {
    runId: String(run.id),
    datasetVersion: run.dataset_version,
    datasetSha256: run.dataset_sha256,
    promptVersion: run.prompt_version,
    modelVersion: run.model_version,
    embeddingModelVersion: run.embedding_model_version,
    rerankerVersion: run.reranker_version,
    knowledgeBaseSnapshot: run.knowledge_base_snapshot,
    retrievalVersion: run.retrieval_version,
    gitRevision: run.git_revision,
    evaluatorVersion: run.evaluator_version,
    metrics: toJsonObject(run.metrics),
    status: run.status,
    createdAt: run.created_at,
    sparseBackend: run.sparse_backend,
    results: rows.map((row) => ({
      caseId: String(row.case_id),
      question: row.question,
      intent: row.intent,
      route: row.route,
      retrievedSourceIds: toJsonList(row.retrieved_source_ids),
      requiredFactPass: row.required_fact_pass,
      abstained: row.abstained,
      latencyMs: row.latency_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      answer: row.answer_text,
      citedSourceIds: toJsonList(row.cited_source_ids),
      toolCalls: toJsonList(row.tool_calls),
      modelRoutes: toJsonList(row.model_routes),
      modelUsage: toJsonList(row.model_usage),
      skillVersions: toJsonList(row.skill_versions),
      toolArgsValid: row.tool_args_valid,
      formatValid: row.format_valid,
      budgetValid: row.budget_valid,
      safetyPassed: row.safety_passed,
      tenantIsolationPassed: row.tenant_isolation_passed,
      estimatedCostCny: row.estimated_cost_cny,
      judge: toJsonObject(row.judge),
      passed: row.passed,
      details: toJsonObject(row.details),
    })),
  };
}
