/**
 * 把 Postgres 中的切片重新向量化并回灌到 Milvus（稠密检索）。
 * 用于更换 embedding 模型、重建 collection 或首次接入。
 *
 * 注意：本脚本会**先整体 drop 整个 collection 再重建**（与 ES 端 deleteIndex() 对齐）。
 * 原因：Milvus 以 chunk_id 为主键，历史切片曾用「32 位无连字符 hex」主键写入，而修复后的
 * buildChunkId 输出「8-4-4-4-12 带连字符」形式——两者是不同主键，纯 upsert 无法清理旧主键，
 * 会留下孤儿向量并继续被 search 命中，重新制造跨存储 chunk_id 不一致。故必须整体重建。
 * PG 是唯一权威源，drop 后从 PG 重读即可完整恢复，无数据丢失。建议在低流量期执行。
 *
 * 用法：
 *   npm run reindex:milvus
 *   MILVUS_REINDEX_ONLY_PUBLISHED=false npm run reindex:milvus   # 连未发布切片一并回灌（更彻底）
 */
import { config } from '@/lib/config';
import { embedDocuments, embeddingIdentity } from '@/lib/services/llm';
import { milvusRepository } from '@/lib/infra/milvus';
import { closePool, query } from '@/lib/db/pool';

const PAGE_SIZE = Math.max(20, Number(process.env.MILVUS_REINDEX_PAGE ?? 200) || 200);
const ONLY_PUBLISHED = String(process.env.MILVUS_REINDEX_ONLY_PUBLISHED ?? 'true').toLowerCase() !== 'false';

interface SourceRow {
  chunk_id: string;
  content: string;
  regions: string[];
  tags: string[];
  document_id: string;
  knowledge_base_id: string;
  status: string;
}

async function main(): Promise<void> {
  const { model } = embeddingIdentity();
  // 全量重建：先整体 drop 整个 collection，再重建。Milvus 以 chunk_id 为主键，旧的
  // 32 位无连字符 hex 主键向量无法被「按新 id upsert」覆盖，会作为孤儿向量残留并继续被
  // search 命中，重新制造跨存储 chunk_id 不一致（详见 lib/infra/milvus.ts dropCollection）。
  // 与 ES 端 deleteIndex() 对齐，必须整体 drop 而非纯 upsert。PG 是权威源，drop 后从 PG
  // 重读即可完整恢复，无数据丢失。
  console.log(`[reindex:milvus] 先整体 drop collection=${config.milvusCollection}（避免旧 32-hex chunk_id 孤儿向量残留）`);
  await milvusRepository.dropCollection();
  await milvusRepository.ensureCollection({ force: false });
  console.log(`[reindex:milvus] 目标 collection=${config.milvusCollection}，模型=${model}`);
  if (!ONLY_PUBLISHED) console.log('[reindex:milvus] 包含未发布文档（published=false）');

  let offset = 0;
  let total = 0;

  for (;;) {
    const rows = await query<SourceRow>(
      `SELECT c.chunk_id,c.content,c.regions,c.tags,
              d.id AS document_id,d.knowledge_base_id,d.status
       FROM travel_document_chunks c
       JOIN travel_documents d ON d.id=c.document_id
       WHERE ($1::boolean = false OR d.status='published')
       ORDER BY d.id,c.chunk_index
       LIMIT $2 OFFSET $3`,
      [ONLY_PUBLISHED, PAGE_SIZE, offset],
    );
    if (!rows.length) break;
    offset += rows.length;

    const embeddings = await embedDocuments(rows.map((row) => String(row.content ?? '')));
    await milvusRepository.upsertChunks(
      rows.map((row, index) => ({
        chunk_id: String(row.chunk_id),
        embedding: embeddings[index],
        knowledge_base_id: String(row.knowledge_base_id),
        document_id: String(row.document_id),
        document_version_id: '1',
        region_codes: (row.regions ?? []).map(String),
        tag_codes: (row.tags ?? []).map(String),
        published: String(row.status) === 'published',
        embedding_model: model,
      })),
    );

    total += rows.length;
    console.log(`[reindex:milvus] 已写入 ${total} 个切片`);
  }

  console.log(`[reindex:milvus] 完成，共 ${total} 个切片`);
}

main()
  .catch((error: unknown) => {
    console.error('[reindex:milvus] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
