/**
 * 混合检索召回评测：dense(Milvus) + sparse(ES) + RRF + rerank。
 * 目的：量化「混合并发」能否把长自然语言召回从 ES-only 的 0.692 拉上去（对应 eval/es-vs-pg_trgm-comparison.md §7.1）。
 *
 * 金标准与 evaluateKeywordRecall.ts 完全一致（按 goldKeywords 反查 PG published 切片 + 去连字符归一化），
 * 保证与 results-v5-elasticsearch.json / results-v5-pg_trgm.json 同口径对比。
 *
 * 用法：
 *   EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v5.json [EVAL_KB_ID=...] npm run eval:hybrid
 * 输出：eval/results-hybrid.json
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { query, closePool } from '@/lib/db/pool';
import { config, validateRuntimeConfig } from '@/lib/config';
import { ragService } from '@/lib/services/rag';

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
    writeFileSync(resolve(process.cwd(), 'eval/eval-hybrid-debug.json'), JSON.stringify(payload, null, 2));
  } catch {
    /* 调试落盘失败不阻断主流程 */
  }
}

/**
 * 金标准解析（后端无关）：切片被判定相关当且仅当包含主实体关键词，且（关键词>1 时）至少包含其余关键词之一。
 * 与被测后端无关，确保 hybrid / ES / pg 三路同口径。
 */
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

async function main(): Promise<void> {
  validateRuntimeConfig();

  // 锁定 hybrid 路径：即便 .env 关闭，评测也强制 dense + ES-sparse + RRF + rerank。
  const mutable = config as unknown as Record<string, boolean>;
  mutable.ragHybridEnabled = true;
  mutable.ragRerankEnabled = true;

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
  const topK = Math.max(1, Number(process.env.EVAL_K ?? dataset.recallK ?? 5));

  const perDimension = new Map<string, { total: number; resolved: number; hits: number; rr: number[] }>();
  const caseResults: Record<string, unknown>[] = [];
  const norm = (value: string): string => value.replace(/-/g, '').toLowerCase();

  for (const item of dataset.cases) {
    const gold = (
      item.expectedSourceIds?.length
        ? item.expectedSourceIds
        : await resolveGoldChunkIds(knowledgeBaseId, item.goldKeywords ?? [])
    ).map(String);

    const sources = await ragService.retrieve(item.question, {
      regions: null,
      knowledgeBaseId,
      limit: topK,
      sparseVariant: 'elasticsearch',
    });
    const topKIds = sources.slice(0, topK).map((source) => String(source.chunkId));
    const topKNorm = topKIds.map(norm);
    const firstHitRank = gold.findIndex((id) => topKNorm.includes(norm(id)));
    const hit = firstHitRank >= 0;
    const reciprocalRank = hit ? 1 / (firstHitRank + 1) : 0;

    const agg =
      perDimension.get(item.dimension) ?? { total: 0, resolved: 0, hits: 0, rr: [] as number[] };
    agg.total += 1;
    if (gold.length) agg.resolved += 1;
    if (hit) agg.hits += 1;
    agg.rr.push(reciprocalRank);
    perDimension.set(item.dimension, agg);

    caseResults.push({
      caseId: item.id,
      question: item.question,
      dimension: item.dimension,
      retrievedSourceIds: topKIds,
      goldSourceIds: gold,
      goldResolved: gold.length > 0,
      hit,
      reciprocalRank,
    });
    console.log(`[eval:hybrid] ${item.id} (${item.dimension}) hit=${hit} gold=${gold.length}`);
  }

  const summary: Record<string, unknown> = {};
  for (const [dimension, agg] of perDimension.entries()) {
    summary[dimension] = {
      total: agg.total,
      resolved: agg.resolved,
      recallAtK: agg.resolved ? agg.hits / agg.resolved : 0,
      mrr: agg.rr.length ? agg.rr.reduce((sum, value) => sum + value, 0) / agg.rr.length : 0,
    };
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

  const output = {
    variant: 'hybrid(ES-sparse+RRF+rerank)',
    topK,
    datasetVersion: asText(dataset.datasetVersion),
    knowledgeBaseId,
    summary,
    results: caseResults,
  };
  const outPath = resolve(process.cwd(), 'eval/results-hybrid.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  writeDebug({ stage: 'done', summary });
  console.log(`[eval:hybrid] 完成 variant=hybrid topK=${topK}，结果已写入 ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error: unknown) => {
    writeDebug({
      stage: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('[eval:hybrid] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
