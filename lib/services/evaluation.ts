/**
 * 评测运行导入与查询。对齐 Python 版 app/services/evaluation.py。
 * 评测用例/结果采用轻量校验（与 eval/schema.py 等价的字段检查），
 * 不引入额外的 Pydantic 依赖。
 */
import {
  createEvalRun,
  saveEvalResult,
  finishEvalRun,
  getEvalRun,
  listEvalRuns,
  getLatestRunBySparseBackend,
} from '../repositories/evaluations';
import { LookupError } from '../errors';

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

interface EvaluationResultInput {
  caseId: string;
  safetyPassed?: boolean;
  tenantIsolationPassed?: boolean;
  budgetValid?: boolean;
  formatValid?: boolean;
  toolArgsValid?: boolean;
  [key: string]: unknown;
}

function casePassed(result: EvaluationResultInput, detail: Record<string, unknown>): boolean {
  if (result.safetyPassed === false || result.tenantIsolationPassed === false) return false;
  if (result.budgetValid === false || result.formatValid === false || result.toolArgsValid === false) {
    return false;
  }
  return Boolean(
    detail.intentPass !== false &&
      detail.routePass !== false &&
      detail.requiredFactPass !== false &&
      detail.forbiddenFactPass !== false &&
      detail.abstentionPass !== false,
  );
}

export const evaluationService = {
  async importRun(
    manifest: Record<string, unknown>,
    cases: Record<string, unknown>[],
    results: Record<string, unknown>[],
  ): Promise<unknown> {
    const caseById = new Map<string, Record<string, unknown>>();
    for (const c of cases ?? []) {
      const id = String(c.id ?? '');
      if (id) caseById.set(id, c);
    }
    const detailById = new Map<string, Record<string, unknown>>();
    const metrics = (manifest.metrics as Record<string, unknown>) || {};
    for (const detail of ((metrics.caseDetails as Record<string, unknown>[]) || [])) {
      const id = String(detail.caseId ?? '');
      if (id) detailById.set(id, detail);
    }
    const normalized: EvaluationResultInput[] = (results ?? []).map((r) => r as EvaluationResultInput);
    for (const result of normalized) {
      if (!caseById.has(String(result.caseId))) {
        caseById.set(String(result.caseId), { id: result.caseId, question: '' });
      }
    }
    if (normalized.length === 0) throw new Error('评测运行至少需要一条结果');
    const digest = String(manifest.datasetSha256 ?? '');
    if (!manifest.datasetVersion || !SHA256_PATTERN.test(digest)) {
      throw new Error('评测 manifest 缺少数据集版本或 SHA-256');
    }
    const runStatus = Boolean(metrics.passed) ? 'completed' : 'failed';
    const runId = await createEvalRun(manifest, 'running');
    try {
      for (const result of normalized) {
        const caseId = String(result.caseId);
        const caseData: Record<string, unknown> = { ...(caseById.get(caseId) || {}) };
        caseData.id = caseId;
        caseData.question = caseData.question || '未知问题';
        const detail: Record<string, unknown> = { ...(detailById.get(caseId) || {}) };
        detail.passed = casePassed(result, detail);
        await saveEvalResult({
          runId,
          caseId,
          question: String(caseData.question ?? '未知问题'),
          result: result as unknown as Record<string, unknown>,
          detail,
        });
      }
      await finishEvalRun(runId, runStatus);
    } catch (error) {
      await finishEvalRun(runId, 'failed');
      throw error;
    }
    const saved = await getEvalRun(runId);
    return saved ?? { runId, status: runStatus, metrics, results: [] };
  },

  listRuns: (limit: number, offset: number, sparseBackend?: string | null) =>
    listEvalRuns(limit, offset, sparseBackend),

  async getRun(runId: string): Promise<unknown> {
    const result = await getEvalRun(runId);
    if (!result) throw new LookupError('评测运行不存在');
    return result as unknown as Record<string, unknown>;
  },

  /**
   * 按稀疏检索后端对比最近一次完成的评测运行（默认 pg_trgm vs elasticsearch），
   * 直接支撑「切换 ES 前后」的指标对照。
   */
  async compareSparseBackends(backends: string[] = ['pg_trgm', 'elasticsearch']): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const backend of backends) {
      out[backend] = (await getLatestRunBySparseBackend(backend)) ?? null;
    }
    return out;
  },
};
