/**
 * 租户感知的向量存储契约与 Milvus 实现。
 * 对齐 Python 版 app/services/vector_store.py + milvus_vector_store.py。
 */
import { MilvusRepository, milvusRepository } from '../infra/milvus';
import { resolveActiveVectorIndex } from '../repositories/platform';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: string, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${fieldName} 必须为 UUID`);
  return normalized.toLowerCase();
}

export class VectorStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorStoreConfigurationError';
  }
}

export interface VectorSearchRequest {
  tenantId: string;
  knowledgeBaseId: string;
  embeddingModel: string;
  embeddingDimension: number;
  embedding: number[];
  regions?: string[];
  limit?: number;
}

export interface VectorUpsertRequest {
  tenantId: string;
  knowledgeBaseId: string;
  embeddingModel: string;
  embeddingDimension: number;
  rows: Array<{
    chunkId: string;
    embedding: number[];
    documentId?: string;
    documentVersionId?: string;
    regionCodes?: string[];
    tagCodes?: string[];
    published?: boolean;
  }>;
}

export interface VectorDeleteRequest {
  tenantId: string;
  knowledgeBaseId: string;
  embeddingModel: string;
  embeddingDimension: number;
  chunkIds: string[];
}

function normalizeSearch(request: VectorSearchRequest): Required<VectorSearchRequest> {
  const tenantId = requireUuid(request.tenantId, 'tenant_id');
  const knowledgeBaseId = requireUuid(request.knowledgeBaseId, 'knowledge_base_id');
  const model = String(request.embeddingModel ?? '').trim();
  if (!model) throw new Error('embedding_model 不能为空');
  const dimension = Number(request.embeddingDimension);
  if (dimension <= 0 || request.embedding.length !== dimension) {
    throw new Error(`embedding 维度 ${request.embedding.length} 与声明维度 ${dimension} 不一致`);
  }
  return {
    tenantId,
    knowledgeBaseId,
    embeddingModel: model,
    embeddingDimension: dimension,
    embedding: request.embedding.map((value) => Number(value)),
    regions: (request.regions ?? []).map(String).filter(Boolean),
    limit: Math.min(Math.max(Number(request.limit ?? 5), 1), 20),
  };
}

export class MilvusVectorStore {
  private readonly repositories = new Map<string, MilvusRepository>();

  constructor(
    private readonly resolveIndex = resolveActiveVectorIndex,
    private readonly legacyRepository = milvusRepository,
  ) {}

  /** 每次调用都从租户 + 知识库解析活动索引，杜绝跨租户或旧 collection 降级。 */
  private async resolve(
    request: Pick<VectorSearchRequest, 'tenantId' | 'knowledgeBaseId' | 'embeddingModel' | 'embeddingDimension'>,
  ): Promise<MilvusRepository> {
    const index = await this.resolveIndex(request.tenantId, request.knowledgeBaseId);
    if (!index) throw new VectorStoreConfigurationError('知识库未绑定活动向量索引');
    if (index.backend !== 'milvus') throw new VectorStoreConfigurationError('知识库活动向量索引不是 Milvus');
    const collection = index.collectionName.trim();
    if (!collection) throw new VectorStoreConfigurationError('知识库活动向量索引配置无效');
    if (index.embeddingModel !== request.embeddingModel || index.embeddingDimension !== request.embeddingDimension) {
      throw new VectorStoreConfigurationError('知识库 embedding 配置不一致');
    }
    const key = `${collection}:${index.embeddingDimension}:${index.embeddingModel}`;
    let repository = this.repositories.get(key);
    if (!repository) {
      repository = new MilvusRepository({
        collectionName: collection,
        dimension: index.embeddingDimension,
        embeddingModel: index.embeddingModel,
      });
      this.repositories.set(key, repository);
    }
    return repository;
  }

  async search(request: VectorSearchRequest): Promise<Array<{ chunkId: string; distance: number }>> {
    const normalized = normalizeSearch(request);
    const repository = await this.resolve(normalized);
    const hits = await repository.search(normalized.embedding, {
      regions: normalized.regions,
      knowledgeBaseId: normalized.knowledgeBaseId,
      limit: normalized.limit,
    });
    return hits
      .filter((hit) => Boolean(hit.chunk_id))
      .map((hit) => ({ chunkId: String(hit.chunk_id), distance: Number(hit.distance ?? 0) }));
  }

  async upsert(request: VectorUpsertRequest): Promise<void> {
    const tenantId = requireUuid(request.tenantId, 'tenant_id');
    const knowledgeBaseId = requireUuid(request.knowledgeBaseId, 'knowledge_base_id');
    const repository = await this.resolve(request);
    await repository.upsertChunks(
      request.rows.map((row) => ({
        chunk_id: String(row.chunkId),
        embedding: row.embedding,
        knowledge_base_id: knowledgeBaseId,
        document_id: row.documentId ?? '',
        document_version_id: row.documentVersionId ?? '',
        region_codes: row.regionCodes ?? [],
        tag_codes: row.tagCodes ?? [],
        published: row.published ?? false,
        embedding_model: request.embeddingModel,
      })),
    );
    void tenantId;
  }

  async delete(request: VectorDeleteRequest): Promise<void> {
    const repository = await this.resolve(request);
    await repository.deleteChunks(request.chunkIds);
  }

  // 旅游旧路由尚未携带租户上下文，保留以下兼容入口，
  // 平台侧的新调用一律走上面的严格契约。
  async searchLegacy(
    embedding: number[],
    options: { regions?: string[]; knowledgeBaseId?: string | null; limit?: number } = {},
  ): Promise<Array<{ chunk_id: string; distance: number }>> {
    const hits = await this.legacyRepository.search(embedding, options);
    return hits.map((hit) => ({ chunk_id: hit.chunk_id, distance: hit.distance }));
  }

  async upsertLegacy(
    rows: Array<{
      chunkId: string;
      embedding: number[];
      knowledgeBaseId?: string;
      documentId?: string;
      documentVersionId?: string;
      regionCodes?: string[];
      tagCodes?: string[];
      published?: boolean;
    }>,
  ): Promise<void> {
    await this.legacyRepository.upsertChunks(
      rows.map((row) => ({
        chunk_id: row.chunkId,
        embedding: row.embedding,
        knowledge_base_id: row.knowledgeBaseId ?? '',
        document_id: row.documentId ?? '',
        document_version_id: row.documentVersionId ?? '',
        region_codes: row.regionCodes ?? [],
        tag_codes: row.tagCodes ?? [],
        published: row.published ?? false,
      })),
    );
  }

  async deleteLegacy(chunkIds: string[]): Promise<void> {
    await this.legacyRepository.deleteChunks(chunkIds);
  }

  async setDocumentPublishedLegacy(documentId: string, published: boolean): Promise<void> {
    await this.legacyRepository.setDocumentPublished(documentId, published);
  }

  async health(): Promise<Record<string, unknown>> {
    return this.legacyRepository.health();
  }
}

export const milvusVectorStore = new MilvusVectorStore();
