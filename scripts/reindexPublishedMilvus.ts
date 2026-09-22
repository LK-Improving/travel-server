/**
 * 把 Postgres 中的切片重新向量化并回灌到 Milvus（稠密检索）。
 * 用于更换 embedding 模型、重建 collection 或首次接入。
 *
 * 用法：
 *   npm run reindex:milvus
 *   MILVUS_REINDEX_ONLY_PUBLISHED=false npm run reindex:milvus
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
