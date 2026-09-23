/**
 * 地市知识文档批量入库脚本（浙江省 11 地市）。
 *
 * 管线与生产一致：原文 → 解析 → 切分 → 落 PG 切片 → 同步 ES（BM25）→ 置 published。
 * 与 worker 的区别：本脚本同步执行，便于一次性批量导入与排查；
 * Milvus（dense）在可达时才写入，不可达则跳过并明确告警（稀疏召回不受影响）。
 *
 * 用法：
 *   npm run ingest:city
 *   CITY_KB_DIR=<目录> npm run ingest:city      # 指定 md 目录
 *   CITY_KB_NAME=<知识库名> npm run ingest:city
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import net from 'node:net';

import { config } from '@/lib/config';
import { query, closePool } from '@/lib/db/pool';
import {
  createDocument,
  findKnowledgeBaseByName,
  createKnowledgeBase,
  replaceDocumentChunks,
  setDocumentStatus,
  transitionDocumentStatus,
  deleteDocument,
} from '@/lib/repositories/knowledge';
import { parseDocument, buildChunks } from '@/lib/services/document_processing';
import { elasticsearchKeywordSearch } from '@/lib/infra/elasticsearch';
import { milvusRepository } from '@/lib/infra/milvus';
import { embedDocuments, embeddingIdentity } from '@/lib/services/llm';

const KB_NAME = process.env.CITY_KB_NAME ?? '浙江省地市旅游美食知识库';
const SOURCE_DIR = process.env.CITY_KB_DIR ?? resolve(process.cwd(), 'docs/city-kb');
/**
 * created_by 是 uuid 且有外键指向 travel_users，必须填真实用户 id。
 * 默认取本地 admin 账号；可用 CITY_KB_ACTOR 覆盖。
 */
const ACTOR = process.env.CITY_KB_ACTOR ?? '239591d6-c1d8-4244-8ed6-3325fe8daa26';

interface CityMeta {
  city: string;
  province: string;
  code: string;
}

/** 从 md 头部元数据行解析城市与地市编码，失败则退化为文件名推断。 */
function parseMeta(content: string, fileName: string): CityMeta {
  const city = content.match(/城市：([^\s|]+)/)?.[1];
  const province = content.match(/省份：([^\s|]+)/)?.[1];
  const code = content.match(/地市编码：(\d+)/)?.[1];
  if (city && code) return { city, province: province ?? '浙江省', code };
  const fallbackCity = fileName.replace(/^\d+_/, '').replace(/\.md$/, '');
  return { city: fallbackCity, province: province ?? '浙江省', code: code ?? '' };
}

/** 快速探测 Milvus 是否可达，避免在无 dense 环境里白等超时。 */
function isPortOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function ensureKnowledgeBase(): Promise<string> {
  const existing = await findKnowledgeBaseByName(KB_NAME);
  if (existing && existing.name === KB_NAME) return existing.id;
  const kb = await createKnowledgeBase(
    {
      name: KB_NAME,
      description: '浙江省 11 个地级市的旅游、美食、特产、民俗与行程知识库（地市维度，用于跨城市检索评测）。',
      status: 'active',
    },
    ACTOR,
  );
  return kb.id;
}

/** 幂等：同知识库下已有同名文档则先删除（切片外键级联，ES 同步删除）。 */
async function removeExisting(knowledgeBaseId: string, title: string): Promise<void> {
  const rows = await query<{ id: string }>(
    'SELECT id FROM travel_documents WHERE knowledge_base_id=$1::uuid AND title=$2',
    [knowledgeBaseId, title],
  );
  for (const row of rows) {
    const id = String(row.id);
    try {
      await elasticsearchKeywordSearch.deleteDocument(id);
    } catch {
      /* ES 中不存在可忽略 */
    }
    await deleteDocument(id);
  }
}

async function main(): Promise<void> {
  const knowledgeBaseId = await ensureKnowledgeBase();
  console.log(`[ingest:city] 知识库：${KB_NAME} (${knowledgeBaseId})`);

  const milvusUp = await isPortOpen(config.milvusHost, config.milvusPort);
  console.log(
    milvusUp
      ? `[ingest:city] Milvus 可达（${config.milvusHost}:${config.milvusPort}），将写入 dense 向量`
      : `[ingest:city] ⚠ Milvus 不可达（${config.milvusHost}:${config.milvusPort}），跳过 dense 向量写入；稀疏（ES）召回不受影响`,
  );

  const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.md')).sort();
  const report: Array<Record<string, unknown>> = [];

  for (const fileName of files) {
    const filePath = join(SOURCE_DIR, fileName);
    const buffer = readFileSync(filePath);
    const meta = parseMeta(buffer.toString('utf8'), fileName);
    const title = `${meta.city}旅游美食知识库`;

    await removeExisting(knowledgeBaseId, title);

    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const objectKey = `${knowledgeBaseId}/${contentHash}/${fileName}`;
    const doc = await createDocument({
      knowledgeBaseId,
      title,
      fileName,
      contentType: 'text/markdown',
      objectKey,
      contentHash,
      // regions 的 CHECK 取值白名单已于迁移 20260921 放开（不再限定杭州 13 区县，可存地市名），
      // 因此这里可直接把地市名写入 regions 以启用城市级过滤；tags 仍保留便于权重叠加。
      regions: [meta.city],
      tags: ['地市', '浙江省', meta.city, '旅游', '美食', '行程'],
      actorId: ACTOR,
    });

    await transitionDocumentStatus(doc.id, ['draft'], 'processing');

    const blocks = await parseDocument(fileName, buffer);
    const chunks = buildChunks(doc.id, blocks);
    if (!chunks.length) {
      await setDocumentStatus(doc.id, 'failed', '切分后没有有效文本块');
      report.push({ fileName, city: meta.city, status: 'failed', chunkCount: 0 });
      continue;
    }

    const tags = ['地市', '浙江省', meta.city, '旅游', '美食', '行程'];
    const regions: string[] = [meta.city];
    let embeddingModel = '';

    if (milvusUp) {
      const { model } = embeddingIdentity();
      const embeddings = await embedDocuments(chunks.map((chunk) => chunk.content));
      embeddingModel = model;
      await replaceDocumentChunks(
        doc.id,
        chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          section: chunk.section,
          page: chunk.page,
          content: chunk.content,
          regions,
          tags,
          embeddingModel,
        })),
      );
      await milvusRepository.upsertChunks(
        chunks.map((chunk, index) => ({
          chunk_id: chunk.chunkId,
          embedding: embeddings[index],
          knowledge_base_id: knowledgeBaseId,
          document_id: doc.id,
          document_version_id: '1',
          region_codes: regions,
          tag_codes: tags,
          published: false,
          embedding_model: model,
        })),
      );
    } else {
      await replaceDocumentChunks(
        doc.id,
        chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          section: chunk.section,
          page: chunk.page,
          content: chunk.content,
          regions,
          tags,
          embeddingModel,
        })),
      );
    }

    // 先置 PG 为 published，再按 published=true 直接写入 ES：
    // 不依赖 indexChunks(false) + setDocumentPublished(true) 的两步，避免写入后未刷新导致漏标。
    await setDocumentStatus(doc.id, 'ready', null, chunks.length);
    await transitionDocumentStatus(doc.id, ['ready'], 'published');

    await elasticsearchKeywordSearch.indexChunks({
      knowledgeBaseId,
      documentId: doc.id,
      title,
      published: true,
      rows: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        content: chunk.content,
        section: chunk.section,
        page: chunk.page,
        tags,
        regions,
        embeddingModel,
      })),
    });

    // 幂等兜底：即便上面已按 published 写入，仍统一同步一次标记（已加 refresh=true）。
    await elasticsearchKeywordSearch.setDocumentPublished(doc.id, true);
    if (milvusUp) {
      try {
        await milvusRepository.setDocumentPublished(doc.id, true);
      } catch {
        /* dense 同步失败不阻断稀疏入库 */
      }
    }

    report.push({
      fileName,
      city: meta.city,
      code: meta.code,
      documentId: doc.id,
      status: 'published',
      chunkCount: chunks.length,
      dense: milvusUp,
    });
    console.log(`[ingest:city] ${fileName} → ${title}：${chunks.length} 切片，已发布`);
  }

  const summary = { knowledgeBaseId, kbName: KB_NAME, milvusUp, documents: report };
  writeFileSync(
    resolve(process.cwd(), 'eval/_ingest_city_summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(`[ingest:city] 完成，共 ${report.length} 个文档，结果写入 eval/_ingest_city_summary.json`);
}

main()
  .catch((error: unknown) => {
    console.error('[ingest:city] 失败：', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
