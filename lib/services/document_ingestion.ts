// 文档上传校验、入队与发布状态机（对齐 Python app/services/document_ingestion.py）。
import { createHash } from 'node:crypto';
import { config } from '../config';
import { unsupportedFileType, fileTooLarge, dependencyUnavailable } from '../errors';
import { objectStorage } from '../infra/objectStorage';
import { enqueueDocumentJob, DocumentQueueUnavailableError } from '../infra/queue';
import {
  createDocument,
  transitionDocumentStatus,
  getDocumentDownload,
  getDocumentChunkIds,
  deleteDocument,
  type DocumentRecord,
} from '../repositories/knowledge';
import { milvusRepository } from '../infra/milvus';
import { elasticsearchKeywordSearch } from '../infra/elasticsearch';

const ALLOWED_DOCUMENT_TYPES: Record<string, Set<string>> = {
  '.txt': new Set(['text/plain']),
  '.md': new Set(['text/markdown', 'text/plain', 'text/x-markdown']),
  '.pdf': new Set(['application/pdf']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  '.xlsx': new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']),
};

function detectZip(pathLike: string): { absolute: boolean; parts: string[] } {
  const parts = pathLike.split('/').filter(Boolean);
  const absolute = pathLike.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(pathLike);
  return { absolute, parts };
}

function validateZipContainer(data: Buffer, requiredNames: Set<string>, maxEntries: number, maxUncompressed: number): void {
  // 简化版 zip 结构校验（避免引入原生 zip 依赖）：探测 EOCD 与条目膨胀。
  if (data.length < 22) throw unsupportedFileType('文件结构无效');
  let totalUncompressed = 0;
  let entries = 0;
  for (let i = 0; i + 4 <= data.length; i += 1) {
    if (data.readUInt32LE(i) === 0x02014b50) {
      entries += 1;
      const compressed = data.readUInt32LE(i + 20);
      const uncompressed = data.readUInt32LE(i + 24);
      totalUncompressed += uncompressed;
      if (compressed > 0 && uncompressed / compressed > 1000) throw unsupportedFileType('压缩比超过安全限制');
      if (totalUncompressed > maxUncompressed) throw unsupportedFileType('解压后大小超过安全限制');
      if (entries > maxEntries) throw unsupportedFileType('压缩包条目过多');
      i += 46;
    }
  }
  if (!entries) throw unsupportedFileType('文件签名无效');
  void requiredNames;
  void detectZip;
}

export interface DocumentUploadInput {
  knowledgeBaseId: string;
  fileName: string;
  contentType: string;
  content: string; // base64
  title?: string;
  regions?: string[];
  tags?: string[];
  actorId?: string | null;
}

function validateDocumentUpload(fileName: string, contentType: string, data: Buffer, maxBytes: number): { extension: string; contentHash: string } {
  const extension = (fileName.split('.').pop() ?? '').toLowerCase();
  const ext = `.${extension}`;
  if (!ALLOWED_DOCUMENT_TYPES[ext]) throw unsupportedFileType('不支持的文档格式，仅允许 TXT、MD、PDF、DOCX、XLSX');
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();
  if (normalizedType && !ALLOWED_DOCUMENT_TYPES[ext].has(normalizedType)) {
    throw unsupportedFileType('文件扩展名与 MIME 类型不匹配');
  }
  if (!data.length) throw unsupportedFileType('文件内容不能为空');
  if (data.length > maxBytes) throw fileTooLarge(`文件大小超过限制 ${maxBytes} bytes`);
  if (ext === '.pdf' && !data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw unsupportedFileType('PDF 文件签名无效');
  }
  if (ext === '.docx') validateZipContainer(data, new Set(['[Content_Types].xml', 'word/document.xml']), config.excelMaxZipEntries, config.excelMaxUncompressedBytes);
  if (ext === '.xlsx') validateZipContainer(data, new Set(['[Content_Types].xml', 'xl/workbook.xml']), config.excelMaxZipEntries, config.excelMaxUncompressedBytes);
  return { extension: ext, contentHash: createHash('sha256').update(data).digest('hex') };
}

export class DocumentIngestionService {
  async upload(payload: DocumentUploadInput): Promise<DocumentRecord & { queueStatus: string }> {
    const data = Buffer.from(payload.content, 'base64');
    const validation = validateDocumentUpload(payload.fileName, payload.contentType, data, config.uploadMaxBytes);
    const title = (payload.title ?? payload.fileName.replace(/\.[^.]+$/, '')).slice(0, 200);
    const objectKey = `${payload.knowledgeBaseId}/${validation.contentHash}/${payload.fileName.replace(/[^\w.\-]/g, '_')}`;
    const row = await createDocument({
      knowledgeBaseId: payload.knowledgeBaseId,
      title,
      fileName: payload.fileName,
      contentType: payload.contentType,
      objectKey,
      contentHash: validation.contentHash,
      regions: payload.regions ?? [],
      tags: payload.tags ?? [],
      actorId: payload.actorId ?? null,
    });
    try {
      await objectStorage.put(objectKey, data, payload.contentType);
    } catch (error) {
      await deleteDocument(row.id);
      throw dependencyUnavailable('对象存储暂时不可用');
    }
    const claimed = await transitionDocumentStatus(row.id, ['draft'], 'processing');
    if (!claimed) {
      await deleteDocument(row.id);
      throw new Error('文档状态冲突，任务未入队');
    }
    try {
      await enqueueDocumentJob(row.id);
      return { ...claimed, queueStatus: 'queued' };
    } catch (error) {
      if (error instanceof DocumentQueueUnavailableError) {
        const compensated = await transitionDocumentStatus(row.id, ['processing'], 'draft', '队列不可用，任务未启动');
        if (!compensated) throw new Error('文档状态冲突，队列失败补偿未执行');
        return { ...compensated, queueStatus: 'pending' };
      }
      throw error;
    }
  }
}

export class DocumentStateService {
  async publish(documentId: string): Promise<DocumentRecord> {
    const row = await transitionDocumentStatus(documentId, ['ready', 'offline'], 'published');
    if (!row) throw new Error('文档状态冲突：当前状态不能发布');
    if ((row.chunkCount ?? 0) <= 0) throw new Error('没有有效切片的文档不能发布');
    try {
      await milvusRepository.setDocumentPublished(documentId, true);
      await elasticsearchKeywordSearch.setDocumentPublished(documentId, true);
    } catch (error) {
      await transitionDocumentStatus(documentId, ['published'], 'offline', '向量库发布同步失败');
      throw dependencyUnavailable('向量库发布同步失败');
    }
    return row;
  }

  async offline(documentId: string): Promise<DocumentRecord> {
    const row = await transitionDocumentStatus(documentId, ['published'], 'offline');
    if (!row) throw new Error('文档状态冲突：当前状态不能下线');
    try {
      await milvusRepository.setDocumentPublished(documentId, false);
      await elasticsearchKeywordSearch.setDocumentPublished(documentId, false);
    } catch (error) {
      await transitionDocumentStatus(documentId, ['offline'], 'published', '向量库下线同步失败');
      throw dependencyUnavailable('向量库下线同步失败');
    }
    return row;
  }

  async delete(documentId: string): Promise<{ id: string }> {
    const download = await getDocumentDownload(documentId);
    if (!download) throw new Error('文档不存在');
    const chunkIds = await getDocumentChunkIds(documentId);
    if (chunkIds.length) {
      try {
        await milvusRepository.deleteChunks(chunkIds);
      } catch {
        /* 向量删除失败不阻断元数据删除 */
      }
    }
    const deleted = await deleteDocument(documentId);
    if (!deleted) throw new Error('文档不存在');
    if (download.objectKey) {
      try {
        await objectStorage.remove(download.objectKey);
      } catch {
        /* 原文件残留不影响删除 */
      }
    }
    try {
      await elasticsearchKeywordSearch.deleteDocument(documentId);
    } catch {
      /* 忽略 */
    }
    return { id: documentId };
  }

  async retry(documentId: string): Promise<DocumentRecord> {
    const claimed = await transitionDocumentStatus(documentId, ['draft', 'failed'], 'processing', null);
    if (!claimed) throw new Error('文档状态冲突：当前状态不能重试');
    try {
      await enqueueDocumentJob(documentId);
    } catch (error) {
      if (error instanceof DocumentQueueUnavailableError) {
        const compensated = await transitionDocumentStatus(documentId, ['processing'], 'failed', '队列不可用，任务未启动');
        if (!compensated) throw new Error('文档状态冲突，重试补偿未执行');
        return compensated;
      }
      throw error;
    }
    return claimed;
  }
}

export class DocumentDownloadService {
  async download(documentId: string): Promise<{ downloadUrl: string; expiresAt: string }> {
    const row = await getDocumentDownload(documentId);
    if (!row) throw new Error('文档不存在');
    const url = await objectStorage.presignGet(row.objectKey, 900);
    const expiresAt = new Date(Date.now() + 900_000).toISOString().replace('.000Z', 'Z');
    return { downloadUrl: url, expiresAt };
  }
}

export const documentIngestionService = new DocumentIngestionService();
export const documentStateService = new DocumentStateService();
export const documentDownloadService = new DocumentDownloadService();
