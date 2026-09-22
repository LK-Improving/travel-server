/**
 * 长自然语言查询改写评测（§7.2 / 路线 #4）。
 *
 * 口径：与 evaluateKeywordRecall.ts 完全一致的"稀疏-only"路径（直接调 KeywordSearchRouter，
 * 不含 dense/rerank），金标准同样按 goldKeywords 反查 PG published 切片 + 去连字符归一化。
 * 同一进程内跑两臂，避免跨进程/跨时段的可比性争议：
 *   OFF 臂 —— 原句直接检索（应复现 §9.2 的 ES-only 基线：长自然语言 0.692）；
 *   ON  臂 —— 先经 rewriteQueryForSparse 改写为关键词短查询，再检索。
 *
 * 用法：
 *   EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v5.json [EVAL_KB_ID=...] npm run eval:rewrite
 * 输出：eval/results-rewrite.json
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { query, closePool } from '@/lib/db/pool';
import { config, validateRuntimeConfig } from '@/lib/config';
import { elasticsearchKeywordSearch, KeywordSearchRouter, type KeywordHit } from '@/lib/infra/elasticsearch';
import { searchChunksByKeyword } from '@/lib/repositories/knowledge';
import { rewriteQueryForSparse, clearRewriteMemo } from '@/lib/services/queryRewrite';

interface EvalCase {
  id: string;
  dimension: string;
  question: string;
  goldKeywords?: string[];
  expectedSourceIds?: string[];
}

async function resolveGoldChunkIds(knowledgeBaseId: string, keywords: string[]): Promise<string[]> {
  if (!keywords.length) return [];
  const [primary, ...rest] = keywords;
  const conds: string[] = [`c.content ILIKE '%' || $2 || '%'`];
  if (rest.length) {
    const restConds = rest.map((_, index) => `c.content ILIKE '%' || $${index + 3} || '%'`);
    conds.push(`(${restConds.join(' OR ')})`);
  }
  const rows = await query<{ chunk_id: string }>(
    `SELECT c.chunk_id
     FROM travel_document_chunks c
     JOIN travel_documents d ON d.id = c.document_id
     JOIN travel_knowledge_bases kb ON kb.id = d.knowledge_base_id
     WHERE d.knowledge_base_id = $1::uuid AND d.status = 'published' AND kb.status = 'active'
       AND ${conds.join(' AND ')}`,
    [knowledgeBaseId, primary, ...rest],
  );
  return rows.map((row) => String(row.chunk_id));
}

interface Bucket {
  total: number;
  resolved: number;
  hits: number;
  rr: number[];
}

function emptyBucket(): Bucket {
  return { total: 0, resolved: 0, hits: 0, rr: [] };
}

function summarize(bucket: Bucket) {
  return {
    total: bucket.total,
    resolved: bucket.resolved,
    recallAtK: bucket.resolved ? bucket.hits / bucket.resolved : 0,
    mrr: bucket.rr.length ? bucket.rr.reduce((sum, value) => sum + value, 0) / bucket.rr.length : 0,
  };
}

async function main(): Promise<void> {
  validateRuntimeConfig();

  const datasetPath =
    process.env.EVAL_DATASET ?? resolve(process.cwd(), 'eval/pg_trgm_keyword_recall_dataset_v5.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as {
    datasetVersion?: string;
    recallK?: number;
    knowledgeBaseId?: string;
    cases: EvalCase[];
  };
  const knowledgeBaseId = process.env.EVAL_KB_ID ?? dataset.knowledgeBaseId;
  if (!knowledgeBaseId) throw new Error('请设置 EVAL_KB_ID 或让数据集内含 knowledgeBaseId');
  const variant = (process.env.EVAL_SPARSE_VARIANT ?? 'elasticsearch') as 'pg_trgm' | 'elasticsearch';
  const topK = Math.max(1, Number(process.env.EVAL_K ?? dataset.recallK ?? 5));
  const mutable = config as unknown as Record<string, unknown>;

  const router = new KeywordSearchRouter(
    elasticsearchKeywordSearch,
    async (queryText: string, regions: string[] | null, kbId: string | null, limit: number, minScore: number) => {
      const hits = await searchChunksByKeyword(queryText, regions, kbId, limit, minScore);
      return hits.map<KeywordHit>((hit) => ({
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        title: hit.title,
        section: hit.section ?? undefined,
        page: hit.page,
        content: hit.content,
        score: hit.score,
      }));
    },
  );

  const norm = (value: string): string => value.replace(/-/g, '').toLowerCase();
  const arms = {
    off: { perDimension: new Map<string, Bucket>(), overall: emptyBucket() },
    on: { perDimension: new Map<string, Bucket>(), overall: emptyBucket() },
  };
  const rewrites: Array<{ caseId: string; dimension: string; original: string; rewritten: string; changed: boolean }> = [];

  async function runArm(
    arm: 'off' | 'on',
    item: EvalCase,
    gold: string[],
  ): Promise<{ hit: boolean; rr: number }> {
    mutable.ragQueryRewriteEnabled = arm === 'on';
    const sparseQuery = await rewriteQueryForSparse(item.question.trim());
    const { hits } = await router.search(item.question.trim(), {
      regions: null,
      knowledgeBaseId,
      limit: topK,
      minScore: config.ragSparseMinScore,
      variant,
      sparseQuery,
    });
    const topKNorm = hits.slice(0, topK).map((hit) => norm(String(hit.chunkId)));
    const firstHitRank = gold.findIndex((id) => topKNorm.includes(norm(id)));
    const hit = firstHitRank >= 0;
    return { hit, rr: hit ? 1 / (firstHitRank + 1) : 0 };
  }

  for (const item of dataset.cases) {
    const gold = (
      item.expectedSourceIds?.length
        ? item.expectedSourceIds
        : await resolveGoldChunkIds(knowledgeBaseId, item.goldKeywords ?? [])
    ).map(String);

    // OFF 臂（基线）
    const off = await runArm('off', item, gold);
    // ON 臂（改写）
    clearRewriteMemo();
    const on = await runArm('on', item, gold);

    for (const [name, result] of [
      ['off', off],
      ['on', on],
    ] as const) {
      const bucket =
        arms[name].perDimension.get(item.dimension) ?? emptyBucket();
      bucket.total += 1;
      if (gold.length) bucket.resolved += 1;
      if (result.hit) bucket.hits += 1;
      bucket.rr.push(result.rr);
      arms[name].perDimension.set(item.dimension, bucket);

      const overall = arms[name].overall;
      overall.total += 1;
      if (gold.length) overall.resolved += 1;
      if (result.hit) overall.hits += 1;
      overall.rr.push(result.rr);
    }

    // 记录改写结果（只看真正被改写的，便于人工核对是否丢实体）
    mutable.ragQueryRewriteEnabled = true;
    clearRewriteMemo();
    const rewritten = await rewriteQueryForSparse(item.question.trim());
    rewrites.push({
      caseId: item.id,
      dimension: item.dimension,
      original: item.question.trim(),
      rewritten,
      changed: rewritten !== item.question.trim(),
    });

    console.log(
      `[eval:rewrite] ${item.id} (${item.dimension}) off=${off.hit} on=${on.hit} changed=${rewritten !== item.question.trim()}`,
    );
  }
  mutable.ragQueryRewriteEnabled = false;

  const build = (arm: 'off' | 'on') => {
    const perDimension: Record<string, ReturnType<typeof summarize>> = {};
    for (const [dimension, bucket] of arms[arm].perDimension.entries()) {
      perDimension[dimension] = summarize(bucket);
    }
    return { perDimension, overall: summarize(arms[arm].overall) };
  };

  const offSummary = build('off');
  const onSummary = build('on');
  const delta: Record<string, { recallAtK: [number, number]; mrr: [number, number]; dRecall: number }> = {};
  for (const dimension of Object.keys(offSummary.perDimension)) {
    const before = offSummary.perDimension[dimension]!;
    const after = onSummary.perDimension[dimension]!;
    delta[dimension] = {
      recallAtK: [before.recallAtK, after.recallAtK],
      mrr: [before.mrr, after.mrr],
      dRecall: after.recallAtK - before.recallAtK,
    };
  }

  const output = {
    variant,
    topK,
    datasetVersion: dataset.datasetVersion ?? '',
    knowledgeBaseId,
    off: offSummary,
    on: onSummary,
    delta,
    changedCount: rewrites.filter((row) => row.changed).length,
    rewrites,
  };
  const outPath = resolve(process.cwd(), 'eval/results-rewrite.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[eval:rewrite] 完成，结果已写入 ${outPath}`);
  console.log(
    JSON.stringify(
      {
        off: offSummary.overall,
        on: onSummary.overall,
        longNl: delta['长自然语言'] ?? null,
        changedCount: output.changedCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error('[eval:rewrite] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
