/**
 * Milvus 向量仓库。与 Python 版 app/repositories/milvus.py 对齐：
 * 同一 collection 名、同一 schema、同一过滤表达式，因此可直接复用已有向量数据。
 */
import { DataType, MilvusClient, type FieldType } from '@zilliz/milvus2-sdk-node';
import { activeEmbeddingModel, config } from '../config';

const ALIAS = 'travel-phase1';

/** Milvus 表达式字符串字面量转义，与 Python 版 _quoted 保持一致。 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface MilvusChunkRow {
  chunk_id: string;
  embedding: number[];
  knowledge_base_id: string;
  document_id: string;
  document_version_id: string;
  region_codes: string[];
  tag_codes: string[];
  published: boolean;
  embedding_model: string;
}

export interface MilvusSearchHit {
  chunk_id: string;
  document_id: string;
  knowledge_base_id: string;
  document_version_id: string;
  region_codes: string[];
  tag_codes: string[];
  embedding_model: string;
  /** COSINE 相似度。Python 版字段名为 distance，这里保留同义字段便于迁移期对照。 */
  distance: number;
  score: number;
}

/**
 * 单一 schema 真源：创建（buildFieldSchemas）与校验（validateCollectionSchema）都从这里派生。
 * 改字段名 / 类型 / 约束只改这一处，避免创建侧与校验侧重复硬编码导致两处漂移。
 */
interface SchemaFieldSpec {
  name: string;
  dataType: DataType;
  isPrimaryKey?: boolean;
  maxLength?: number;
  elementType?: DataType;
  maxCapacity?: number;
}

const SCHEMA_SPEC: SchemaFieldSpec[] = [
  { name: 'chunk_id', dataType: DataType.VarChar, isPrimaryKey: true, maxLength: 64 },
  { name: 'embedding', dataType: DataType.FloatVector },
  { name: 'knowledge_base_id', dataType: DataType.VarChar, maxLength: 64 },
  { name: 'document_id', dataType: DataType.VarChar, maxLength: 64 },
  { name: 'document_version_id', dataType: DataType.VarChar, maxLength: 64 },
  { name: 'region_codes', dataType: DataType.Array, elementType: DataType.VarChar, maxCapacity: 3, maxLength: 32 },
  { name: 'tag_codes', dataType: DataType.Array, elementType: DataType.VarChar, maxCapacity: 32, maxLength: 64 },
  { name: 'published', dataType: DataType.Bool },
  { name: 'embedding_model', dataType: DataType.VarChar, maxLength: 255 },
];

function buildFieldSchemas(dimension: number): FieldType[] {
  return SCHEMA_SPEC.map((spec): FieldType => {
    if (spec.dataType === DataType.FloatVector) {
      return { name: spec.name, data_type: DataType.FloatVector, dim: dimension };
    }
    if (spec.dataType === DataType.Array) {
      return {
        name: spec.name,
        data_type: DataType.Array,
        element_type: spec.elementType!,
        max_capacity: spec.maxCapacity!,
        max_length: spec.maxLength!,
      };
    }
    const field: FieldType = { name: spec.name, data_type: spec.dataType };
    if (spec.isPrimaryKey) (field as { is_primary_key?: boolean }).is_primary_key = true;
    if (spec.maxLength !== undefined) (field as { max_length?: number }).max_length = spec.maxLength;
    return field;
  });
}

export function validateEmbeddingModels(models: string[], expectedModel: string): void {
  const unexpected = [...new Set(models.map(String).filter((model) => model !== expectedModel))].sort();
  if (unexpected.length) {
    throw new Error(`Milvus collection embedding 模型混用：expected=${expectedModel}, found=${unexpected.join(',')}`);
  }
}

/**
 * describeCollection 的响应在不同 SDK 版本里字段位置不一致：
 * 有的直接给 fields，有的包在 schema.fields 下，这里统一兜一层。
 */
function describeFields(described: unknown): unknown[] {
  const record = described as { fields?: unknown[]; schema?: { fields?: unknown[] } };
  return record.fields ?? record.schema?.fields ?? [];
}

/** 把 describe 字段归一化成数值型 data_type（兼容 data_type 字符串 与 dataType 数值两种返回结构）。 */
function normDataType(field: { dataType?: unknown; data_type?: unknown }): number {
  const v = field.dataType ?? field.data_type;
  if (typeof v === 'number') return v;
  return (DataType as unknown as Record<string, number>)[String(v)] ?? -1;
}

/** 取向量维度（兼容顶层 dim 与 type_params.dim 两种返回结构）。 */
function fieldDim(field: { dim?: unknown; type_params?: Array<{ key: string; value: unknown }> }): number {
  const d = field.dim ?? field.type_params?.find((p) => p.key === 'dim')?.value;
  return Number(d ?? 0);
}

/** 校验已有 collection 的 schema 与 SCHEMA_SPEC 一致，避免静默写入错误结构。 */
export function validateCollectionSchema(fields: FieldType[], dimension: number): void {
  const byName = new Map(fields.map((field) => [String((field as { name: unknown }).name), field]));
  const expectedNames = new Set(SCHEMA_SPEC.map((field) => field.name));
  const missing = [...expectedNames].filter((name) => !byName.has(name)).sort();
  const extra = [...byName.keys()].filter((name) => !expectedNames.has(name)).sort();
  if (missing.length || extra.length) {
    throw new Error(`Milvus schema 字段不匹配：missing=${missing.join(',')}, extra=${extra.join(',')}`);
  }
  for (const spec of SCHEMA_SPEC) {
    const actual = byName.get(spec.name)! as { dataType?: unknown; data_type?: unknown };
    if (normDataType(actual) !== spec.dataType) {
      throw new Error(`Milvus schema 字段类型不匹配：${spec.name}`);
    }
  }
  const chunkId = byName.get('chunk_id')! as { is_primary_key?: boolean };
  if (!chunkId.is_primary_key) throw new Error('Milvus schema chunk_id 必须是主键');
  const embeddingDim = fieldDim(byName.get('embedding') as { dim?: unknown; type_params?: Array<{ key: string; value: unknown }> });
  if (embeddingDim !== dimension) {
    throw new Error(`Milvus schema 向量维度与配置维度 ${dimension} 不一致`);
  }
  // VARCHAR 长度校验（从 SCHEMA_SPEC 派生，避免与创建侧重复硬编码）。
  for (const spec of SCHEMA_SPEC) {
    if (spec.dataType === DataType.VarChar && spec.maxLength !== undefined) {
      const actual = Number((byName.get(spec.name) as { max_length?: unknown }).max_length ?? 0);
      if (actual !== spec.maxLength) throw new Error(`Milvus schema VARCHAR 长度不匹配：${spec.name}`);
    }
  }
  // 数组约束校验（elementType / maxCapacity / maxLength），同样从 SCHEMA_SPEC 派生。
  for (const spec of SCHEMA_SPEC) {
    if (spec.dataType === DataType.Array) {
      const field = byName.get(spec.name) as { element_type?: unknown; max_capacity?: unknown; max_length?: unknown };
      if (
        normDataType({ data_type: field.element_type }) !== spec.elementType ||
        Number(field.max_capacity ?? 0) !== spec.maxCapacity ||
        Number(field.max_length ?? 0) !== spec.maxLength
      ) {
        throw new Error(`Milvus schema ${spec.name} 数组约束不匹配`);
      }
    }
  }
}

export class MilvusRepository {
  readonly dimension: number;
  readonly collectionName: string;
  readonly embeddingModel: string;

  private client: MilvusClient | null = null;
  private ensuring: Promise<{ collectionName: string; dimension: number; embeddingModel: string }> | null = null;
  private ensured = false;

  constructor(options: { dimension?: number; collectionName?: string; embeddingModel?: string } = {}) {
    this.dimension = options.dimension ?? config.embeddingDimension;
    this.collectionName = options.collectionName ?? config.milvusCollection;
    this.embeddingModel = options.embeddingModel ?? activeEmbeddingModel();
  }

  private getClient(): MilvusClient {
    if (!this.client) {
      const address = `${config.milvusHost}:${config.milvusPort}`;
      this.client = new MilvusClient({
        address,
        ...(config.milvusUser ? { user: config.milvusUser, password: config.milvusPassword } : {}),
        pool: { max: 8, min: 0, idleTimeoutMillis: 30_000 },
      });
    }
    return this.client;
  }

  private requireEmbeddingModel(): string {
    if (!this.embeddingModel) {
      throw new Error('embedding 模型未配置（OLLAMA 用 OLLAMA_EMBEDDING_MODEL，其他供应商用 EMBEDDING_MODEL）');
    }
    return this.embeddingModel;
  }

  /** 幂等地确保 collection 与索引就绪。并发调用共享同一个 Promise。 */
  async ensureCollection(options: { force?: boolean } = {}): Promise<{
    collectionName: string;
    dimension: number;
    embeddingModel: string;
  }> {
    const model = this.requireEmbeddingModel();
    if (!options.force && this.ensured) {
      return { collectionName: this.collectionName, dimension: this.dimension, embeddingModel: model };
    }
    if (!this.ensuring || options.force) {
      this.ensuring = this.doEnsure(model).finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async doEnsure(model: string) {
    const client = this.getClient();
    const has = await client.hasCollection({ collection_name: this.collectionName });

    if (has.value) {
      const described = await client.describeCollection({ collection_name: this.collectionName });
      validateCollectionSchema((describeFields(described)) as unknown as FieldType[], this.dimension);
    } else {
      await client.createCollection({
        collection_name: this.collectionName,
        fields: buildFieldSchemas(this.dimension),
        description: 'Travel document chunks v2',
        enable_dynamic_field: false,
      });
      await client.createIndex({
        collection_name: this.collectionName,
        field_name: 'embedding',
        index_type: config.milvusIndexType,
        metric_type: config.milvusMetricType,
        params: { M: 16, efConstruction: 200 },
      });
      // 标量索引在不同 Milvus 小版本支持度不同，失败不影响过滤正确性。
      for (const field of ['knowledge_base_id', 'document_id', 'published', 'embedding_model']) {
        try {
          await client.createIndex({
            collection_name: this.collectionName,
            field_name: field,
            index_type: 'INVERTED',
          });
        } catch {
          /* 忽略 */
        }
      }
    }

    await client.loadCollection({ collection_name: this.collectionName });

    const probe = await client.query({
      collection_name: this.collectionName,
      filter: `embedding_model != ${quoted(model)}`,
      output_fields: ['embedding_model'],
      limit: 1,
    });
    validateEmbeddingModels(
      (probe.data ?? []).map((row) => String((row as { embedding_model?: string }).embedding_model ?? '')),
      model,
    );

    this.ensured = true;
    return { collectionName: this.collectionName, dimension: this.dimension, embeddingModel: model };
  }

  /**
   * 健康检查用一次真实查询代替版本号接口：
   * SDK 未提供稳定的 getServerVersion，能列出 collection 即视为连通。
   */
  async health(): Promise<Record<string, unknown>> {
    const client = this.getClient();
    const listed = await client.listCollections();
    const names = (listed?.data ?? []).map((item) => String((item as { name?: string }).name ?? ''));
    return {
      reachable: true,
      collections: names,
      hasCollection: names.includes(this.collectionName),
      host: config.milvusHost,
      port: config.milvusPort,
      collectionName: this.collectionName,
    };
  }

  private validateEmbedding(embedding: number[]): void {
    if (embedding.length !== this.dimension) {
      throw new Error(`embedding 维度 ${embedding.length} 与配置维度 ${this.dimension} 不一致`);
    }
  }

  async upsertChunks(rows: Array<Partial<MilvusChunkRow> & { chunk_id: string; embedding: number[] }>): Promise<void> {
    if (!rows.length) return;
    const model = this.requireEmbeddingModel();
    for (const row of rows) {
      this.validateEmbedding(row.embedding);
      if (String(row.embedding_model ?? '') && String(row.embedding_model) !== model) {
        throw new Error(`embedding_model 必须为当前配置模型 ${model}`);
      }
    }
    await this.ensureCollection({ force: true });
    const data = rows.map((row) => ({
      chunk_id: String(row.chunk_id),
      embedding: row.embedding.map((value) => Number(value)),
      knowledge_base_id: String(row.knowledge_base_id ?? ''),
      document_id: String(row.document_id ?? ''),
      document_version_id: String(row.document_version_id ?? ''),
      region_codes: [...(row.region_codes ?? [])],
      tag_codes: [...(row.tag_codes ?? [])],
      published: Boolean(row.published ?? false),
      embedding_model: model,
    }));
    const client = this.getClient();
    await client.upsert({ collection_name: this.collectionName, data });
    await client.flush({ collection_names: [this.collectionName] });
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    const safeIds = chunkIds.map(String).filter(Boolean);
    if (!safeIds.length) return;
    await this.ensureCollection({ force: true });
    const expression = `chunk_id in [${safeIds.map(quoted).join(',')}]`;
    const client = this.getClient();
    await client.delete({ collection_name: this.collectionName, filter: expression });
    await client.flush({ collection_names: [this.collectionName] });
  }

  /**
   * 全量重建前清空整个 collection。
   *
   * 关键：Milvus 以 chunk_id 为主键（VarChar(64)）。历史切片曾用「32 位无连字符 hex」
   * 作为 chunk_id 写入，而修复后的 buildChunkId 输出「8-4-4-4-12 带连字符」形式——
   * 两者是同一 128 位值的不同字符串表示，但作为主键是**不同字符串**，因此 upsert
   * 只能覆盖同主键、无法清理旧主键。若只 upsert 不 drop，旧 32-hex 向量会作为孤儿残留：
   * 它们 published=true，仍会被 search 命中，却对应 PG/ES 中不存在的 chunk_id，重新制造
   * #7 要消除的跨存储比对不一致。故 reindex 必须整体 drop 再重建，与 ES 端 deleteIndex() 对齐。
   */
  async dropCollection(): Promise<void> {
    const client = this.getClient();
    const has = await client.hasCollection({ collection_name: this.collectionName });
    if (has.value) {
      await client.dropCollection({ collection_name: this.collectionName });
    }
    this.ensured = false;
    this.ensuring = null;
  }

  async setDocumentPublished(documentId: string, published: boolean): Promise<void> {
    await this.ensureCollection({ force: true });
    const client = this.getClient();
    const rows = await client.query({
      collection_name: this.collectionName,
      filter: `document_id == ${quoted(String(documentId))}`,
      output_fields: [
        'chunk_id',
        'embedding',
        'knowledge_base_id',
        'document_id',
        'document_version_id',
        'region_codes',
        'tag_codes',
        'published',
        'embedding_model',
      ],
      limit: 16_384,
    });
    if (rows.data?.length) {
      const updated = rows.data.map((row) => ({ ...row, published: Boolean(published) }));
      await client.upsert({ collection_name: this.collectionName, data: updated as never });
      await client.flush({ collection_names: [this.collectionName] });
    }
  }

  static buildFilter(options: {
    embeddingModel: string;
    regions?: string[] | null;
    knowledgeBaseId?: string | null;
  }): string {
    const expressions = ['published == true', `embedding_model == ${quoted(options.embeddingModel)}`];
    if (options.knowledgeBaseId) {
      expressions.push(`knowledge_base_id == ${quoted(options.knowledgeBaseId)}`);
    }
    if (options.regions?.length) {
      const regionFilter = options.regions.map((region) => `ARRAY_CONTAINS(region_codes, ${quoted(region)})`).join(' or ');
      expressions.push(`(${regionFilter})`);
    }
    return expressions.join(' and ');
  }

  async search(
    embedding: number[],
    options: { regions?: string[] | null; knowledgeBaseId?: string | null; limit?: number } = {},
  ): Promise<MilvusSearchHit[]> {
    this.validateEmbedding(embedding);
    if (!this.ensured) await this.ensureCollection();

    const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 200);
    const result = await this.getClient().search({
      collection_name: this.collectionName,
      data: [embedding.map((value) => Number(value))],
      anns_field: 'embedding',
      limit,
      filter: MilvusRepository.buildFilter({
        embeddingModel: this.embeddingModel,
        regions: options.regions,
        knowledgeBaseId: options.knowledgeBaseId,
      }),
      output_fields: [
        'chunk_id',
        'document_id',
        'knowledge_base_id',
        'document_version_id',
        'region_codes',
        'tag_codes',
        'embedding_model',
      ],
      params: { ef: config.milvusSearchEf },
    });

    return (result.results ?? []).map((hit) => {
      const score = Number(hit.score ?? 0);
      return {
        chunk_id: String(hit.chunk_id ?? ''),
        document_id: String(hit.document_id ?? ''),
        knowledge_base_id: String(hit.knowledge_base_id ?? ''),
        document_version_id: String(hit.document_version_id ?? ''),
        region_codes: (hit.region_codes as string[]) ?? [],
        tag_codes: (hit.tag_codes as string[]) ?? [],
        embedding_model: String(hit.embedding_model ?? ''),
        distance: score,
        score,
      };
    });
  }
}

export const milvusRepository = new MilvusRepository();
export { ALIAS as MILVUS_ALIAS, quoted as milvusQuoted };
