/**
 * 文档解析管线：原文下载 → 解析 → 切分 → 向量化 → 落库 → 同步 Milvus/ES。
 * 对齐 Python 版 app/workers/document_jobs.py。
 *
 * 契约：任何一步失败都必须把文档置为 failed 并写入错误信息，
 * 不允许留下 processing 悬空状态。
 */
import { createHash } from 'node:crypto';
import { config } from '../config';
import { embedDocuments, embeddingIdentity } from './llm';
import { splitText } from './rag';
import { objectStorage } from '../infra/objectStorage';
import { milvusRepository } from '../infra/milvus';
import { elasticsearchKeywordSearch } from '../infra/elasticsearch';
import {
  getProcessingDocument,
  replaceDocumentChunks,
  setDocumentStatus,
  updateDocumentProgress,
} from '../repositories/knowledge';

export interface ParsedBlock {
  content: string;
  section?: string | null;
  page?: number | null;
}

export interface BuiltChunk {
  chunkId: string;
  chunkIndex: number;
  section: string | null;
  page: number | null;
  content: string;
}

/**
 * 确定性 chunk_id：同一文档重复处理时保持幂等，避免向量库堆积孤儿向量。
 * 输出规整为带连字符的 uuid 形式（8-4-4-4-12），使 PG（uuid 列会自动加连字符）、
 * ES、Milvus 三处存储的 chunk_id 表示完全一致——否则 ES 存 32 位无连字符 hex、
 * PG 显示带连字符，跨存储按 chunk_id 比对/联表会永远不相等。
 * 该不一致曾导致评测里 ES 命中率被误判为 0（见 eval/es-vs-pg_trgm-comparison.md §9.4）。
 */
export function buildChunkId(documentId: string, chunkIndex: number): string {
  const hex = createHash('sha256').update(`${documentId}::${chunkIndex}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
}

// ---------------------------------------------------------------- 解析器

async function parsePlainText(data: Buffer): Promise<ParsedBlock[]> {
  const text = normalizeText(data.toString('utf8'));
  return text ? [{ content: text }] : [];
}

async function parsePdf(data: Buffer): Promise<ParsedBlock[]> {
  const pdfParse = (await import('pdf-parse')).default;
  const result = await pdfParse(data);
  const text = normalizeText(String(result?.text ?? ''));
  return text ? [{ content: text }] : [];
}

async function parseDocx(data: Buffer): Promise<ParsedBlock[]> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: data });
  const text = normalizeText(String(result?.value ?? ''));
  return text ? [{ content: text }] : [];
}

/** 单元格值归一化：富文本、超链接、公式结果、日期都要能取出可读文本。 */
function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((item) => String((item as Record<string, unknown>)?.text ?? ''))
        .join('')
        .trim();
    }
    if (record.result !== undefined && record.result !== null) return stringifyCellValue(record.result);
    if (typeof record.text === 'string') return record.text.trim();
    if (typeof record.hyperlink === 'string') return record.hyperlink;
    return '';
  }
  return String(value).trim();
}

async function parseXlsx(data: Buffer): Promise<ParsedBlock[]> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const blocks: ParsedBlock[] = [];
  let totalCells = 0;
  let truncated = false;

  for (const sheet of workbook.worksheets) {
    if (blocks.length >= config.excelMaxSheets) break;
    const lines: string[] = [];
    let rows = 0;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows >= config.excelMaxRows || truncated) return;
      rows += 1;
      const values: string[] = [];
      let columns = 0;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (columns >= config.excelMaxColumns) return;
        columns += 1;
        totalCells += 1;
        if (totalCells > config.excelMaxCells) {
          truncated = true;
          return;
        }
        const text = stringifyCellValue(cell.value);
        if (text) values.push(text);
      });
      const line = values.join(' | ').trim();
      if (line) lines.push(line);
    });

    if (lines.length) blocks.push({ content: normalizeText(lines.join('\n')), section: sheet.name });
    if (truncated) break;
  }
  return blocks;
}

const PARSERS: Record<string, (data: Buffer) => Promise<ParsedBlock[]>> = {
  '.txt': parsePlainText,
  '.md': parsePlainText,
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.xlsx': parseXlsx,
};

export async function parseDocument(fileName: string, data: Buffer): Promise<ParsedBlock[]> {
  const extension = `.${(fileName.split('.').pop() ?? '').toLowerCase()}`;
  const parser = PARSERS[extension];
  if (!parser) throw new Error(`不支持的文档格式：${extension}`);
  return parser(data);
}

// ---------------------------------------------------------------- 切分

export function buildChunks(
  documentId: string,
  blocks: ParsedBlock[],
  chunkSize: number = config.ragChunkSize,
  chunkOverlap: number = config.ragChunkOverlap,
): BuiltChunk[] {
  const chunks: BuiltChunk[] = [];
  for (const block of blocks) {
    const pieces = splitText(block.content, chunkSize, chunkOverlap);
    for (const piece of pieces) {
      const content = piece.trim();
      if (!content) continue;
      chunks.push({
        chunkId: buildChunkId(documentId, chunks.length),
        chunkIndex: chunks.length,
        section: block.section ?? null,
        page: block.page ?? null,
        content,
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------- 管线

export interface ProcessResult {
  documentId: string;
  chunkCount: number;
  embeddingModel: string;
}

export class DocumentProcessingService {
  /**
   * 处理单个文档。失败时写入 failed 状态后重抛，由 worker 决定是否重试。
   */
  async process(documentId: string): Promise<ProcessResult> {
    const document = await getProcessingDocument(documentId);
    if (!document) throw new Error(`文档不存在：${documentId}`);

    const { model: embeddingModel } = embeddingIdentity();
    try {
      await updateDocumentProgress(documentId, '读取原文', 5);
      const data = await objectStorage.get(document.objectKey);

      await updateDocumentProgress(documentId, '解析文本', 20);
      const blocks = await parseDocument(document.fileName, data);
      if (!blocks.length) throw new Error('未能解析出有效文本内容');

      await updateDocumentProgress(documentId, '文本切分', 35);
      const chunks = buildChunks(documentId, blocks);
      if (!chunks.length) throw new Error('切分后没有有效文本块');

      await updateDocumentProgress(documentId, `向量化（0/${chunks.length}）`, 45);
      const embeddings = await embedDocuments(chunks.map((chunk) => chunk.content));
      if (embeddings.length !== chunks.length) {
        throw new Error(`embedding 数量不匹配：期望 ${chunks.length}，实际 ${embeddings.length}`);
      }

      await updateDocumentProgress(documentId, '写入切片', 70);
      const regions = document.regions ?? [];
      const tags = document.tags ?? [];
      await replaceDocumentChunks(
        documentId,
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

      await updateDocumentProgress(documentId, '同步向量库', 85);
      await milvusRepository.upsertChunks(
        chunks.map((chunk, index) => ({
          chunk_id: chunk.chunkId,
          embedding: embeddings[index],
          knowledge_base_id: document.knowledgeBaseId,
          document_id: documentId,
          document_version_id: String(document.version ?? 1),
          region_codes: regions,
          tag_codes: tags,
          published: false,
          embedding_model: embeddingModel,
        })),
      );

      await elasticsearchKeywordSearch.indexChunks({
        knowledgeBaseId: document.knowledgeBaseId,
        documentId,
        title: document.title,
        published: false,
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

      await updateDocumentProgress(documentId, '处理完成', 100);
      await setDocumentStatus(documentId, 'ready', null, chunks.length);
      return { documentId, chunkCount: chunks.length, embeddingModel };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await setDocumentStatus(documentId, 'failed', message.slice(0, 500));
      } catch {
        /* 状态回写失败不能吞掉原始错误 */
      }
      throw error;
    }
  }
}

export const documentProcessingService = new DocumentProcessingService();
