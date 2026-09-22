/**
 * 关键词稀疏召回评测：pg_trgm vs Elasticsearch。
 * 直接复用生产路由 KeywordSearchRouter（与 lib/services/rag.ts 接线一致），
 * 仅测稀疏召回，不依赖 Milvus / embedding。金标准由 goldKeywords 经 PG 内容反查独立得到。
 *
 * 用法（需先确保知识库已入库 PG 且已 npm run reindex:es）：
 *   EVAL_KB_ID=<知识库uuid> EVAL_SPARSE_VARIANT=pg_trgm    npm run eval:keyword
 *   EVAL_KB_ID=<知识库uuid> EVAL_SPARSE_VARIANT=elasticsearch npm run eval:keyword
 * 两遍跑完后在运营台 GET /api/admin/evaluations/compare 对比，或导入结果做留存。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { query, closePool } from '@/lib/db/pool';
import { config, validateRuntimeConfig } from '@/lib/config';
import {
  elasticsearchKeywordSearch,
  KeywordSearchRouter,
  type KeywordHit,
} from '@/lib/infra/elasticsearch';
import { searchChunksByKeyword } from '@/lib/repositories/knowledge';

interface EvalCase {
  id: string;
  dimension: string;
  question: string;
  goldKeywords?: string[];
  expectedSourceIds?: string[];
  resolvedEntity?: string;
  note?: string;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function writeDebug(payload: unknown): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(resolve(process.cwd(), 'eval/eval-debug.json'), JSON.stringify(payload, null, 2));
  } catch {
    /* 调试落盘失败不阻断主流程 */
  }
}


/**
 * 金标准解析（后端无关）：一个切片被判定为「相关」当且仅当
 *  - 包含主实体关键词 goldKeywords[0]（保证主题相关），且
 *  - 当关键词 > 1 个时，至少包含其余关键词中的任意一个（保证命中答题切片，而非仅擦边提及）。
 * 旧实现要求单一切片同时包含【全部】关键词（AND），在本语料下几乎不可解；
 * 改为主实体 + 任意上下文词（OR）后，金标准精确可解且与被测后端无关。
 */
async function resolveGoldChunkIds(knowledgeBaseId: string, keywords: string[]): Promise<string[]> {
  if (!keywords.length) return [];
  const [primary, ...rest] = keywords;
  // 注意：ILIKE 必须包 % 才可能子串匹配；不包 % 等价于精确相等，永远命中不了长正文。
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

async function main(): Promise<void> {
  validateRuntimeConfig();
  const variant = (process.env.EVAL_SPARSE_VARIANT ?? 'pg_trgm') as 'pg_trgm' | 'elasticsearch' | 'ab';
  const knowledgeBaseId = process.env.EVAL_KB_ID;
  if (!knowledgeBaseId) throw new Error('请设置 EVAL_KB_ID（要评测的知识库 uuid）');

  const datasetPath = process.env.EVAL_DATASET ?? resolve(process.cwd(), 'eval/pg_trgm_keyword_recall_dataset.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as { datasetVersion?: string; recallK?: number; cases: EvalCase[] };
  const topK = Math.max(1, Number(process.env.EVAL_K ?? dataset.recallK ?? 5));

  const router = new KeywordSearchRouter(elasticsearchKeywordSearch, async (queryText, regions, kbId, limit, minScore) => {
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
  });

  const perDimension = new Map<string, { total: number; resolved: number; hits: number; rr: number[] }>();
  const caseResults: Record<string, unknown>[] = [];

  for (const item of dataset.cases) {
    const gold = (item.expectedSourceIds?.length ? item.expectedSourceIds : await resolveGoldChunkIds(knowledgeBaseId, item.goldKeywords ?? [])).map(String);
    const { hits, backend } = await router.search(item.question, {
      regions: null,
      knowledgeBaseId,
      limit: topK,
      minScore: config.ragSparseMinScore,
      variant,
    });
    const topKIds = hits.slice(0, topK).map((hit) => String(hit.chunkId));
    // chunk_id 在 PG（uuid 列）会被规整成带连字符形式，而在 ES（keyword）按 buildChunkId 原样存为 32 位无连字符 hex。
    // 两存储的展示形式不一致，直接字符串比对会永远不相等，导致 ES 命中率被低估为 0。
    // 统一去连字符 + 小写后再比较，才是真实的"是否命中同一分片"。
    const norm = (value: string): string => value.replace(/-/g, '').toLowerCase();
    const topKNorm = topKIds.map(norm);
    const firstHitRank = gold.findIndex((id) => topKNorm.includes(norm(id)));
    const hit = firstHitRank >= 0;
    const reciprocalRank = hit ? 1 / (firstHitRank + 1) : 0;

    const agg = perDimension.get(item.dimension) ?? { total: 0, resolved: 0, hits: 0, rr: [] };
    agg.total += 1;
    if (gold.length) agg.resolved += 1;
    if (hit) agg.hits += 1;
    agg.rr.push(reciprocalRank);
    perDimension.set(item.dimension, agg);

    caseResults.push({
      caseId: item.id,
      question: item.question,
      dimension: item.dimension,
      backend,
      retrievedSourceIds: topKIds,
      goldSourceIds: gold,
      goldResolved: gold.length > 0,
      hit,
      reciprocalRank,
    });
    console.log(`[eval:keyword] ${item.id} (${item.dimension}) backend=${backend} hit=${hit} gold=${gold.length}`);
  }

  const summary: Record<string, unknown> = {};
  for (const [dimension, agg] of perDimension.entries()) {
    const recallAtK = agg.resolved ? agg.hits / agg.resolved : 0;
    const mrr = agg.rr.length ? agg.rr.reduce((sum, value) => sum + value, 0) / agg.rr.length : 0;
    summary[dimension] = { total: agg.total, resolved: agg.resolved, recallAtK, mrr };
  }
  const allRr = [...perDimension.values()].flatMap((agg) => agg.rr);
  const allHits = [...perDimension.values()].reduce((sum, agg) => sum + agg.hits, 0);
  const allResolved = [...perDimension.values()].reduce((sum, agg) => sum + agg.resolved, 0);
  summary.overall = {
    total: [...perDimension.values()].reduce((sum, agg) => sum + agg.total, 0),
    resolved: allResolved,
    recallAtK: allResolved ? allHits / allResolved : 0,
    mrr: allRr.length ? allRr.reduce((sum, value) => sum + value, 0) / allRr.length : 0,
  };

  const output = { variant, topK, datasetVersion: asText(dataset.datasetVersion), summary, results: caseResults };
  const outPath = resolve(process.cwd(), `eval/results-${variant}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  writeDebug({ stage: 'done', variant, summary });
  console.log(`[eval:keyword] 完成 variant=${variant} topK=${topK}，结果已写入 ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error: unknown) => {
    writeDebug({ stage: 'error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    console.error('[eval:keyword] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
