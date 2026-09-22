/**
 * 把 Postgres 中的切片全量回灌到 Elasticsearch（BM25 稀疏检索）。
 * 用于 ES 索引重建或首次接入。
 *
 * 用法：
 *   npm run reindex:es
 *   ES_REINDEX_PAGE=500 npm run reindex:es
 */
import { elasticsearchKeywordSearch } from '@/lib/infra/elasticsearch';
import { listChunksForElasticsearch } from '@/lib/repositories/knowledge';
import { closePool } from '@/lib/db/pool';

const PAGE_SIZE = Math.max(50, Number(process.env.ES_REINDEX_PAGE ?? 500) || 500);

async function main(): Promise<void> {
  let offset = 0;
  let total = 0;

  // 切换 analyzer / mapping 后必须删除旧索引再重建，否则字段分析器变更不会生效。
  // 索引不存在时返回 404，视为可忽略（首次接入场景）。
  await elasticsearchKeywordSearch.deleteIndex();

  for (;;) {
    const rows = await listChunksForElasticsearch(PAGE_SIZE, offset);
    if (!rows.length) break;
    offset += rows.length;

    // 按文档聚合后逐文档批量写入，保证 published 标记与文档状态一致。
    const byDocument = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byDocument.get(row.documentId);
      if (list) list.push(row);
      else byDocument.set(row.documentId, [row]);
    }

    for (const [documentId, chunks] of byDocument) {
      const head = chunks[0];
      await elasticsearchKeywordSearch.indexChunks({
        knowledgeBaseId: head.knowledgeBaseId,
        documentId,
        title: head.documentTitle,
        published: head.documentStatus === 'published',
        rows: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          content: chunk.content,
          section: chunk.section,
          page: chunk.page,
          tags: chunk.tags,
          regions: chunk.regions,
          embeddingModel: chunk.embeddingModel,
        })),
      });
      total += chunks.length;
    }
    console.log(`[reindex:es] 已写入 ${total} 个切片`);
  }

  console.log(`[reindex:es] 完成，共 ${total} 个切片`);
}

main()
  .catch((error: unknown) => {
    console.error('[reindex:es] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
