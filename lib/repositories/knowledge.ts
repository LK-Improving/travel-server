/**
 * 知识库、文档与切片的数据访问。
 * 对应 Python 版 repositories/postgres.py 的知识库与文档域方法。
 * PostgreSQL 只保存正文、展示元数据、状态与审计；向量本身在 Milvus。
 */
import { execute, executeMany, query, queryOne, toJsonObject, transaction } from '../db/pool';
import { DomainConflictError } from '../errors';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  status: string;
  documentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export type DocumentStatus = 'draft' | 'processing' | 'failed' | 'ready' | 'published' | 'offline';

export interface DocumentRecord {
  id: string;
  knowledgeBaseId: string;
  title: string;
  fileName: string;
  status: DocumentStatus;
  regions: string[];
  tags: string[];
  chunkCount: number;
  errorMessage: string | null;
  progress: number;
  processingStage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DocumentProcessingRow {
  id: string;
  knowledgeBaseId: string;
  title: string;
  fileName: string;
  objectKey: string;
  version: number;
  status: string;
  regions: string[];
  tags: string[];
}

export interface ChunkRow {
  chunkId: string;
  chunkIndex: number;
  section: string | null;
  page: number | null;
  content: string;
  regions: string[];
  tags: string[];
  embeddingModel: string;
}

export interface ChunkSource {
  chunkId: string;
  documentId: string;
  title: string;
  section: string | null;
  page: number | null;
  content: string;
}

export interface KeywordChunkHit extends ChunkSource {
  score: number;
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  description: string;
  status: string;
  document_count: number;
  created_at: string;
  updated_at: string;
}

interface DocumentDbRow {
  id: string;
  knowledge_base_id: string;
  title: string;
  file_name: string;
  status: DocumentStatus;
  regions: string[];
  tags: string[];
  chunk_count: number;
  error_message: string | null;
  progress: number | null;
  processing_stage: string | null;
  created_at: string;
  updated_at: string;
}

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    status: row.status,
    documentCount: Number(row.document_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocument(row: DocumentDbRow): DocumentRecord {
  return {
    id: String(row.id),
    knowledgeBaseId: String(row.knowledge_base_id),
    title: row.title,
    fileName: row.file_name,
    status: row.status,
    regions: (row.regions ?? []).map(String),
    tags: (row.tags ?? []).map(String),
    chunkCount: Number(row.chunk_count),
    errorMessage: row.error_message,
    progress: Number(row.progress ?? 0),
    processingStage: row.processing_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DOCUMENT_COLUMNS = `id,knowledge_base_id,title,file_name,status,regions,tags,chunk_count,error_message,
  progress,processing_stage,created_at,updated_at`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function listKnowledgeBases(limit: number, offset: number): Promise<KnowledgeBase[]> {
  const rows = await query<KnowledgeBaseRow>(
    `SELECT kb.id,kb.name,kb.description,kb.status,kb.created_at,kb.updated_at,
            COUNT(d.id)::int AS document_count
     FROM travel_knowledge_bases kb LEFT JOIN travel_documents d ON d.knowledge_base_id=kb.id
     GROUP BY kb.id ORDER BY kb.updated_at DESC,kb.id LIMIT $1 OFFSET $2`,
    [clamp(limit, 1, 100), Math.max(offset, 0)],
  );
  return rows.map(toKnowledgeBase);
}

export async function createKnowledgeBase(
  payload: { name: string; description?: string; status?: string },
  actorId: string,
): Promise<KnowledgeBase> {
  const row = await queryOne<KnowledgeBaseRow>(
    `INSERT INTO travel_knowledge_bases (name,description,status,created_by)
     VALUES ($1,$2,$3,$4) RETURNING id,name,description,status,created_at,updated_at,0::int AS document_count`,
    [payload.name, payload.description ?? '', payload.status ?? 'active', actorId],
  );
  return toKnowledgeBase(row!);
}

export async function getKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | null> {
  const row = await queryOne<KnowledgeBaseRow>(
    `SELECT kb.id,kb.name,kb.description,kb.status,kb.created_at,kb.updated_at,COUNT(d.id)::int AS document_count
     FROM travel_knowledge_bases kb LEFT JOIN travel_documents d ON d.knowledge_base_id=kb.id
     WHERE kb.id=$1 GROUP BY kb.id`,
    [knowledgeBaseId],
  );
  return row ? toKnowledgeBase(row) : null;
}

export async function updateKnowledgeBase(
  knowledgeBaseId: string,
  payload: { name?: string | null; description?: string | null; status?: string | null },
): Promise<KnowledgeBase | null> {
  const row = await queryOne<KnowledgeBaseRow>(
    `UPDATE travel_knowledge_bases SET
       name=COALESCE($2,name),description=COALESCE($3,description),status=COALESCE($4,status)
     WHERE id=$1 RETURNING id,name,description,status,created_at,updated_at,
       (SELECT COUNT(*)::int FROM travel_documents WHERE knowledge_base_id=$1) AS document_count`,
    [knowledgeBaseId, payload.name ?? null, payload.description ?? null, payload.status ?? null],
  );
  return row ? toKnowledgeBase(row) : null;
}

export async function deleteKnowledgeBase(knowledgeBaseId: string): Promise<boolean> {
  try {
    const affected = await execute('DELETE FROM travel_knowledge_bases WHERE id=$1', [knowledgeBaseId]);
    return affected === 1;
  } catch (error) {
    if ((error as { code?: string }).code === PG_FOREIGN_KEY_VIOLATION) {
      throw new DomainConflictError('知识库存在文档，不能删除');
    }
    throw error;
  }
}

/** 模糊匹配名称定位知识库，完全相等优先；供对话把自然语言映射到知识库 ID。 */
export async function findKnowledgeBaseByName(name: string): Promise<KnowledgeBase | null> {
  const row = await queryOne<KnowledgeBaseRow>(
    `SELECT kb.id,kb.name,kb.description,kb.status,kb.created_at,kb.updated_at,COUNT(d.id)::int AS document_count
     FROM travel_knowledge_bases kb LEFT JOIN travel_documents d ON d.knowledge_base_id=kb.id
     WHERE kb.name ILIKE '%'||$1::text||'%'
     GROUP BY kb.id ORDER BY (kb.name=$1::text) DESC,kb.updated_at DESC LIMIT 1`,
    [name],
  );
  return row ? toKnowledgeBase(row) : null;
}

export interface CreateDocumentInput {
  knowledgeBaseId: string;
  title: string;
  fileName: string;
  contentType: string;
  objectKey: string;
  contentHash: string;
  regions: string[];
  tags: string[];
  actorId?: string | null;
}

export async function createDocument(payload: CreateDocumentInput): Promise<DocumentRecord> {
  try {
    const row = await queryOne<DocumentDbRow>(
      `INSERT INTO travel_documents
         (knowledge_base_id,title,file_name,content_type,object_key,content_hash,regions,tags,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${DOCUMENT_COLUMNS}`,
      [
        payload.knowledgeBaseId,
        payload.title,
        payload.fileName,
        payload.contentType,
        payload.objectKey,
        payload.contentHash,
        payload.regions,
        payload.tags,
        payload.actorId ?? null,
      ],
    );
    return toDocument(row!);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === PG_UNIQUE_VIOLATION) throw new Error('同一知识库中已存在相同内容的文档');
    if (code === PG_FOREIGN_KEY_VIOLATION) throw new Error('知识库不存在');
    throw error;
  }
}

export async function listAdminDocuments(options: {
  knowledgeBaseId?: string | null;
  status?: string | null;
  limit: number;
  offset: number;
}): Promise<DocumentRecord[]> {
  const rows = await query<DocumentDbRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM travel_documents
     WHERE ($1::uuid IS NULL OR knowledge_base_id=$1) AND ($2::text IS NULL OR status=$2)
     ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
    [options.knowledgeBaseId ?? null, options.status ?? null, clamp(options.limit, 1, 100), Math.max(options.offset, 0)],
  );
  return rows.map(toDocument);
}

export async function getAdminDocument(documentId: string): Promise<DocumentRecord | null> {
  const row = await queryOne<DocumentDbRow>(`SELECT ${DOCUMENT_COLUMNS} FROM travel_documents WHERE id=$1`, [
    documentId,
  ]);
  return row ? toDocument(row) : null;
}

export async function getDocumentDownload(documentId: string): Promise<{ objectKey: string } | null> {
  const row = await queryOne<{ object_key: string }>('SELECT object_key FROM travel_documents WHERE id=$1', [
    documentId,
  ]);
  return row ? { objectKey: String(row.object_key) } : null;
}

export async function getProcessingDocument(documentId: string): Promise<DocumentProcessingRow | null> {
  const row = await queryOne<{
    id: string;
    knowledge_base_id: string;
    title: string;
    file_name: string;
    object_key: string;
    version: number;
    status: string;
    regions: string[];
    tags: string[];
  }>(
    `SELECT id,knowledge_base_id,title,file_name,object_key,version,status,regions,tags
     FROM travel_documents WHERE id=$1`,
    [documentId],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    knowledgeBaseId: String(row.knowledge_base_id),
    title: row.title,
    fileName: row.file_name,
    objectKey: row.object_key,
    version: Number(row.version),
    status: row.status,
    regions: (row.regions ?? []).map(String),
    tags: (row.tags ?? []).map(String),
  };
}

/** 无条件设置状态；worker 与运营台共用，ready 视为 100%。 */
export async function setDocumentStatus(
  documentId: string,
  status: string,
  errorMessage: string | null = null,
  chunkCount: number | null = null,
): Promise<DocumentRecord> {
  const row = await queryOne<DocumentDbRow>(
    `UPDATE travel_documents SET status=$2::text,error_message=$3,
       chunk_count=COALESCE($4,chunk_count),
       retry_count=retry_count+(CASE WHEN $2::text='processing' THEN 1 ELSE 0 END),
       progress=(CASE WHEN $2::text='ready' THEN 100 WHEN $2::text='processing' THEN 0 ELSE progress END),
       processing_stage=(CASE WHEN $2::text='processing' THEN '排队等待' ELSE NULL END)
     WHERE id=$1 RETURNING ${DOCUMENT_COLUMNS}`,
    [documentId, status, errorMessage, chunkCount],
  );
  if (!row) throw new Error('文档不存在');
  return toDocument(row);
}

/** 带前置状态校验的状态迁移，用于发布/下线/重试等受控流转。 */
export async function transitionDocumentStatus(
  documentId: string,
  expectedStatuses: string[],
  newStatus: string,
  errorMessage: string | null = null,
  chunkCount: number | null = null,
): Promise<DocumentRecord | null> {
  const row = await queryOne<DocumentDbRow>(
    `UPDATE travel_documents SET status=$3::text,error_message=$4,
       chunk_count=COALESCE($5,chunk_count),
       retry_count=retry_count+(CASE WHEN $3::text='processing' THEN 1 ELSE 0 END),
       progress=(CASE WHEN $3::text='ready' THEN 100 WHEN $3::text='processing' THEN 0 ELSE progress END),
       processing_stage=(CASE WHEN $3::text='processing' THEN '排队等待' ELSE NULL END)
     WHERE id=$1 AND status=ANY($2::text[])
     RETURNING ${DOCUMENT_COLUMNS}`,
    [documentId, expectedStatuses, newStatus, errorMessage, chunkCount],
  );
  return row ? toDocument(row) : null;
}

/** 分阶段回写解析进度，仅在 processing 状态生效，避免覆盖终态。 */
export async function updateDocumentProgress(
  documentId: string,
  stage: string | null,
  progress: number,
): Promise<void> {
  await execute(
    "UPDATE travel_documents SET processing_stage=$2,progress=$3 WHERE id=$1 AND status='processing'",
    [documentId, stage, clamp(Math.trunc(progress), 0, 100)],
  );
}

export async function deleteDocumentPlaceholder(documentId: string): Promise<boolean> {
  const affected = await execute("DELETE FROM travel_documents WHERE id=$1 AND status='draft' AND chunk_count=0", [
    documentId,
  ]);
  return affected === 1;
}

/** 删除文档行，切片由外键 ON DELETE CASCADE 一并清理。 */
export async function deleteDocument(documentId: string): Promise<boolean> {
  const affected = await execute('DELETE FROM travel_documents WHERE id=$1', [documentId]);
  return affected === 1;
}

export async function replaceDocumentChunks(
  documentId: string,
  chunks: Array<{
    chunkId: string;
    chunkIndex: number;
    section?: string | null;
    page?: number | null;
    content: string;
    regions: string[];
    tags: string[];
    embeddingModel: string;
  }>,
): Promise<void> {
  await transaction(async (client) => {
    await client.query('DELETE FROM travel_document_chunks WHERE document_id=$1', [documentId]);
    await executeMany(
      client,
      `INSERT INTO travel_document_chunks
         (chunk_id,document_id,chunk_index,section,page,content,regions,tags,embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      chunks.map((chunk) => [
        chunk.chunkId,
        documentId,
        chunk.chunkIndex,
        chunk.section ?? null,
        chunk.page ?? null,
        chunk.content,
        chunk.regions,
        chunk.tags,
        chunk.embeddingModel,
      ]),
    );
  });
}

export async function getDocumentChunkIds(documentId: string): Promise<string[]> {
  const rows = await query<{ chunk_id: string }>(
    'SELECT chunk_id FROM travel_document_chunks WHERE document_id=$1',
    [documentId],
  );
  return rows.map((row) => String(row.chunk_id));
}

export async function listDocumentChunks(
  documentId: string,
  limit: number,
  offset: number,
): Promise<ChunkRow[]> {
  const rows = await query<{
    chunk_id: string;
    chunk_index: number;
    section: string | null;
    page: number | null;
    content: string;
    regions: string[];
    tags: string[];
    embedding_model: string;
  }>(
    `SELECT chunk_id,chunk_index,section,page,content,regions,tags,embedding_model
     FROM travel_document_chunks WHERE document_id=$1 ORDER BY chunk_index LIMIT $2 OFFSET $3`,
    [documentId, clamp(limit, 1, 100), Math.max(offset, 0)],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    chunkIndex: Number(row.chunk_index),
    section: row.section,
    page: row.page,
    content: row.content,
    regions: (row.regions ?? []).map(String),
    tags: (row.tags ?? []).map(String),
    embeddingModel: row.embedding_model,
  }));
}

export async function documentStatistics(
  knowledgeBaseId: string | null,
): Promise<Array<{ status: string; documentCount: number; chunkCount: number }>> {
  const rows = await query<{ status: string; document_count: number; chunk_count: number }>(
    `SELECT status,COUNT(*)::int AS document_count,COALESCE(SUM(chunk_count),0)::int AS chunk_count
     FROM travel_documents WHERE ($1::uuid IS NULL OR knowledge_base_id=$1)
     GROUP BY status ORDER BY status`,
    [knowledgeBaseId],
  );
  return rows.map((row) => ({
    status: row.status,
    documentCount: Number(row.document_count),
    chunkCount: Number(row.chunk_count),
  }));
}

export async function listChunksForExport(options: {
  knowledgeBaseId?: string | null;
  documentId?: string | null;
  maxRows: number;
}): Promise<
  Array<
    ChunkRow & {
      documentId: string;
      documentTitle: string;
      fileName: string;
    }
  >
> {
  const rows = await query<{
    chunk_id: string;
    chunk_index: number;
    section: string | null;
    page: number | null;
    content: string;
    regions: string[];
    tags: string[];
    embedding_model: string;
    document_id: string;
    document_title: string;
    file_name: string;
  }>(
    `SELECT c.chunk_id,c.chunk_index,c.section,c.page,c.content,c.regions,c.tags,c.embedding_model,
            d.id AS document_id,d.title AS document_title,d.file_name
     FROM travel_document_chunks c JOIN travel_documents d ON d.id=c.document_id
     WHERE ($1::uuid IS NULL OR d.knowledge_base_id=$1) AND ($2::uuid IS NULL OR c.document_id=$2)
     ORDER BY d.title,d.id,c.chunk_index LIMIT $3`,
    [options.knowledgeBaseId ?? null, options.documentId ?? null, clamp(Math.trunc(options.maxRows), 1, 20_000)],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    chunkIndex: Number(row.chunk_index),
    section: row.section,
    page: row.page,
    content: row.content,
    regions: (row.regions ?? []).map(String),
    tags: (row.tags ?? []).map(String),
    embeddingModel: row.embedding_model,
    documentId: String(row.document_id),
    documentTitle: row.document_title,
    fileName: row.file_name,
  }));
}

export async function listChunksForElasticsearch(
  limit: number,
  offset: number,
): Promise<
  Array<{
    chunkId: string;
    documentId: string;
    knowledgeBaseId: string;
    documentTitle: string;
    documentStatus: string;
    section: string | null;
    page: number | null;
    content: string;
    regions: string[];
    tags: string[];
    embeddingModel: string;
  }>
> {
  const rows = await query<{
    chunk_id: string;
    document_id: string;
    knowledge_base_id: string;
    title: string;
    status: string;
    section: string | null;
    page: number | null;
    content: string;
    regions: string[];
    tags: string[];
    embedding_model: string;
  }>(
    `SELECT c.chunk_id,c.document_id,d.knowledge_base_id,d.title,d.status,
            c.section,c.page,c.content,c.regions,c.tags,c.embedding_model
     FROM travel_document_chunks c JOIN travel_documents d ON d.id=c.document_id
     ORDER BY c.document_id,c.chunk_index LIMIT $1 OFFSET $2`,
    [clamp(Math.trunc(limit), 1, 1000), Math.max(Math.trunc(offset), 0)],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    knowledgeBaseId: String(row.knowledge_base_id),
    documentTitle: row.title,
    documentStatus: row.status,
    section: row.section,
    page: row.page,
    content: row.content,
    regions: (row.regions ?? []).map(String),
    tags: (row.tags ?? []).map(String),
    embeddingModel: row.embedding_model,
  }));
}

/** 只回填仍处于 published 且知识库 active 的正文，避免下线内容继续被引用。 */
export async function fetchPublishedChunkSources(chunkIds: string[]): Promise<ChunkSource[]> {
  if (!chunkIds.length) return [];
  const rows = await query<{
    chunk_id: string;
    document_id: string;
    title: string;
    section: string | null;
    page: number | null;
    content: string;
  }>(
    `SELECT c.chunk_id,c.document_id,d.title,c.section,c.page,c.content
     FROM travel_document_chunks c
     JOIN travel_documents d ON d.id=c.document_id
     JOIN travel_knowledge_bases kb ON kb.id=d.knowledge_base_id
     WHERE c.chunk_id=ANY($1::uuid[]) AND d.status='published' AND kb.status='active'`,
    [chunkIds],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    title: row.title,
    section: row.section,
    page: row.page,
    content: row.content,
  }));
}

/** 项目会话检索：额外约束租户与知识库范围，杜绝跨租户取正文。 */
export async function fetchProjectChunkSources(
  tenantId: string,
  knowledgeBaseId: string,
  chunkIds: string[],
): Promise<ChunkSource[]> {
  if (!chunkIds.length) return [];
  const rows = await query<{
    chunk_id: string;
    document_id: string;
    title: string;
    section: string | null;
    page: number | null;
    content: string;
  }>(
    `SELECT c.chunk_id,c.document_id,d.title,c.section,c.page,c.content
     FROM travel_document_chunks c
     JOIN travel_documents d ON d.id=c.document_id
     JOIN travel_knowledge_bases kb ON kb.id=d.knowledge_base_id
     JOIN ai_tenant_knowledge_bases tenant_kb
       ON tenant_kb.knowledge_base_id=kb.id AND tenant_kb.tenant_id=$1
     WHERE c.chunk_id=ANY($2::uuid[]) AND d.knowledge_base_id=$3
       AND d.status='published' AND kb.status='active'`,
    [tenantId, chunkIds, knowledgeBaseId],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    title: row.title,
    section: row.section,
    page: row.page,
    content: row.content,
  }));
}

/**
 * pg_trgm 稀疏召回。word_similarity(query, content) 衡量 query 与 content 任意子串的
 * 最佳三元组相似度，适合「短问题命中长切片」，与稠密向量召回互补。
 */
export async function searchChunksByKeyword(
  queryText: string,
  regions: string[] | null,
  knowledgeBaseId: string | null,
  limit: number,
  minScore = 0.05,
): Promise<KeywordChunkHit[]> {
  const rows = await query<{
    chunk_id: string;
    document_id: string;
    title: string;
    section: string | null;
    page: number | null;
    content: string;
    score: number;
  }>(
    `SELECT c.chunk_id,c.document_id,d.title,c.section,c.page,c.content,
            word_similarity($1,c.content) AS score
     FROM travel_document_chunks c
     JOIN travel_documents d ON d.id=c.document_id
     JOIN travel_knowledge_bases kb ON kb.id=d.knowledge_base_id
     WHERE d.status='published' AND kb.status='active'
       AND word_similarity($1,c.content) >= $3
       AND ($4::uuid IS NULL OR d.knowledge_base_id=$4::uuid)
       AND ($5::text[] IS NULL OR c.regions && $5::text[])
     ORDER BY score DESC LIMIT $2`,
    [queryText, clamp(Math.trunc(limit), 1, 50), Number(minScore), knowledgeBaseId, regions?.length ? regions : null],
  );
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    title: row.title,
    section: row.section,
    page: row.page,
    content: row.content,
    score: Number(row.score),
  }));
}

export { toJsonObject };
