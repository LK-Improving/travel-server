/**
 * 将关键词稀疏召回评测结果（eval/results-<variant>.json）暂存进评测框架：
 * 写入 ai_eval_runs（metrics 不可变快照 + sparse_backend 打标）与 ai_eval_results（逐用例证据），
 * 便于后续 ES 评测跑完后通过 /api/admin/evaluations/compare 直接对照。
 *
 * 用法：
 *   EVAL_KB_ID=<kb> node --import tsx scripts/importKeywordEvalBaseline.ts [results-json-path]
 * 不传路径时默认 eval/results-pg_trgm.json；variant 从结果文件里的 variant 字段读取并写入 sparse_backend。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { closePool } from '@/lib/db/pool';
import { createEvalRun, saveEvalResult } from '@/lib/repositories/evaluations';

const LOG = resolve(process.cwd(), 'eval/import-baseline.log');
function log(...p: unknown[]): void {
  appendFileSync(LOG, p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

interface CaseResult {
  caseId: string;
  question: string;
  dimension: string;
  backend: string;
  retrievedSourceIds: string[];
  goldSourceIds: string[];
  goldResolved: boolean;
  hit: boolean;
  reciprocalRank: number;
}

async function main(): Promise<void> {
  const resultsPath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), 'eval/results-pg_trgm.json');
  const kbId = process.env.EVAL_KB_ID ?? 'fded519d-0984-49b9-8a72-d2db0ad983aa';
  const variant = (process.env.EVAL_SPARSE_VARIANT ?? 'pg_trgm') as string;

  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
    variant: string;
    topK: number;
    datasetVersion: string;
    summary: Record<string, { total: number; resolved: number; recallAtK: number; mrr: number }>;
    results: CaseResult[];
  };
  const datasetPath = resolve(process.cwd(), process.env.EVAL_DATASET ?? 'eval/pg_trgm_keyword_recall_dataset.json');
  const datasetSha256 = createHash('sha256').update(readFileSync(datasetPath)).digest('hex');

  const backend = results.variant || variant;
  log('stashing variant=', backend, 'kb=', kbId, 'dataset=', results.datasetVersion);

  const runId = await createEvalRun(
    {
      datasetVersion: results.datasetVersion,
      datasetSha256,
      promptVersion: 'keyword-sparse-recall',
      modelVersion: backend,
      embeddingModelVersion: 'n/a',
      rerankerVersion: null,
      knowledgeBaseSnapshot: kbId,
      retrievalVersion: `sparse-only/${backend}`,
      gitRevision: null,
      evaluatorVersion: '2.0',
      metrics: results.summary as unknown as Record<string, unknown>,
      sparseBackend: backend,
    },
    'completed',
  );
  log('created runId=', runId);

  for (const item of results.results) {
    await saveEvalResult({
      runId,
      caseId: item.caseId,
      question: item.question,
      result: {
        retrievedSourceIds: item.retrievedSourceIds,
        route: item.backend,
        passed: item.hit,
        details: item,
      },
      detail: { ...item, passed: item.hit },
    });
  }
  log('saved', results.results.length, 'cases');

  writeFileSync(
    resolve(process.cwd(), 'eval/import-baseline.json'),
    JSON.stringify({ runId, backend, kbId, datasetVersion: results.datasetVersion, cases: results.results.length }, null, 2),
  );
  log('DONE runId=', runId);
}

main()
  .catch((e: unknown) => {
    log('ERROR=', e instanceof Error ? e.stack ?? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
