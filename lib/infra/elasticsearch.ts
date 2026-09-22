/**
 * Elasticsearch BM25 稀疏检索适配器。
 * 与 Python 版 app/services/es_keyword_search.py 对齐：直接用 HTTP 调用，
 * 不引入官方客户端，PostgreSQL 始终是切片正文与元数据的唯一权威来源。
 */
import { createHash } from 'node:crypto';
import { config } from '../config';

const INDEX_PATTERN = /^[a-z0-9][a-z0-9_-]{0,254}$/;

export interface KeywordHit {
  chunkId: string;
  documentId: string;
  title?: string;
  section?: string;
  page?: number | null;
  content: string;
  score: number;
}

export interface ChunkIndexRow {
  chunkId: string;
  content: string;
  section?: string | null;
  page?: number | null;
  tags?: string[];
  regions?: string[];
  embeddingModel?: string;
}

export class ElasticsearchKeywordSearch {
  get configured(): boolean {
    return Boolean(config.elasticsearchUrl.trim());
  }

  private index(): string {
    const value = config.elasticsearchIndex.trim().toLowerCase();
    if (!INDEX_PATTERN.test(value)) throw new Error('ELASTICSEARCH_INDEX 格式无效');
    return value;
  }

  private headers(ndjson = false): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.elasticsearchApiKey) headers.Authorization = `ApiKey ${config.elasticsearchApiKey}`;
    // 带 body 的请求必须声明 Content-Type，否则 ES 8.x 返回 406 Not Acceptable。
    headers['Content-Type'] = ndjson ? 'application/x-ndjson' : 'application/json';
    return headers;
  }

  private async request(path: string, init: RequestInit & { ndjson?: boolean } = {}): Promise<Response> {
    const { ndjson, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.elasticsearchTimeoutMs);
    try {
      return await fetch(`${config.elasticsearchUrl}${path}`, {
        ...rest,
        headers: { ...this.headers(ndjson), ...(rest.headers ?? {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureIndex(): Promise<void> {
    if (!this.configured) return;
    const mapping = {
      mappings: {
        properties: {
          chunk_id: { type: 'keyword' },
          document_id: { type: 'keyword' },
          knowledge_base_id: { type: 'keyword' },
          title: { type: 'text', analyzer: config.elasticsearchAnalyzer, search_analyzer: config.elasticsearchSearchAnalyzer },
          section: { type: 'text', analyzer: config.elasticsearchAnalyzer, search_analyzer: config.elasticsearchSearchAnalyzer },
          content: { type: 'text', analyzer: config.elasticsearchAnalyzer, search_analyzer: config.elasticsearchSearchAnalyzer },
          page: { type: 'integer' },
          tags: { type: 'keyword' },
          region_codes: { type: 'keyword' },
          published: { type: 'boolean' },
          embedding_model: { type: 'keyword' },
        },
      },
    };
    const response = await this.request(`/${this.index()}`, { method: 'PUT', body: JSON.stringify(mapping) });
    // 400 表示索引已存在且 mapping 冲突，与 Python 版同样放行。
    if (![200, 201, 400].includes(response.status)) {
      throw new Error(`Elasticsearch 建索引失败：HTTP ${response.status}`);
    }
  }

  async deleteIndex(): Promise<void> {
    if (!this.configured) return;
    const index = this.index();
    const response = await this.request(`/${index}`, { method: 'DELETE' });
    // 200 = 已删除；404 = 索引本就不存在（首次接入 / 回灌前清理场景允许）。
    if (![200, 404].includes(response.status)) {
      throw new Error(`Elasticsearch 删除索引失败：HTTP ${response.status}`);
    }
  }

  async indexChunks(options: {
    knowledgeBaseId: string;
    documentId: string;
    title: string;
    rows: ChunkIndexRow[];
    published?: boolean;
  }): Promise<void> {
    if (!this.configured || !options.rows.length) return;
    await this.ensureIndex();
    const index = this.index();
    const lines: string[] = [];
    for (const row of options.rows) {
      const chunkId = String(row.chunkId);
      lines.push(JSON.stringify({ index: { _index: index, _id: chunkId } }));
      lines.push(
        JSON.stringify({
          chunk_id: chunkId,
          document_id: String(options.documentId),
          knowledge_base_id: String(options.knowledgeBaseId),
          title: String(options.title),
          section: row.section ?? null,
          content: String(row.content ?? ''),
          page: row.page ?? null,
          tags: [...(row.tags ?? [])],
          region_codes: [...(row.regions ?? [])],
          published: Boolean(options.published ?? false),
          embedding_model: String(row.embeddingModel ?? ''),
        }),
      );
    }
    const response = await this.request('/_bulk', {
      method: 'POST',
      ndjson: true,
      body: `${lines.join('\n')}\n`,
    });
    if (!response.ok) throw new Error(`Elasticsearch 批量写入失败：HTTP ${response.status}`);
    const payload = (await response.json()) as { errors?: boolean };
    if (payload.errors) throw new Error('Elasticsearch 批量写入存在失败项');
  }

  async search(
    query: string,
    options: { regions?: string[] | null; knowledgeBaseId?: string | null; limit: number },
  ): Promise<KeywordHit[]> {
    if (!this.configured) return [];
    const filters: unknown[] = [{ term: { published: true } }];
    if (options.knowledgeBaseId) filters.push({ term: { knowledge_base_id: String(options.knowledgeBaseId) } });
    if (options.regions?.length) filters.push({ terms: { region_codes: [...options.regions] } });

    const body = {
      size: Math.min(Math.max(Number(options.limit), 1), 50),
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                fields: ['title^3', 'section^2', 'content', 'tags^4'],
                // cross_fields 将多字段视作一个整体匹配，更适合「短查询词跨 title/section/content 命中文档」；
                // 配合中文分词器（ik_smart）在查询期切词，召回与精度均优于默认 best_fields + standard。
                type: 'cross_fields',
                operator: 'or',
                tie_breaker: 0.3,
                analyzer: config.elasticsearchSearchAnalyzer,
                auto_generate_synonyms_phrase_query: false,
              },
            },
          ],
          // 第二路与错字鲁棒性对齐 pg_trgm：ES 不允许在 cross_fields 上启用 fuzziness，
          // 故用独立的 best_fields should 子句携带 fuzziness:'AUTO'。minimum_should_match 默认 0，
          // 该子句为纯加分项——正常查询不受影响，错字查询（如 3 字 token 摇橹般→摇橹船）可被模糊召回。
          // 注：AUTO 对长度<=2 的 token 给 0 编辑距离，因此 2 字错字（西胡→西湖）仍需 pg_trgm 三元组兜底；
          // 若要覆盖 2 字错字需显式 fuzziness:1。
          should: [
            {
              multi_match: {
                query,
                fields: ['title^3', 'section^2', 'content', 'tags^4'],
                type: 'best_fields',
                operator: 'or',
                tie_breaker: 0.3,
                analyzer: config.elasticsearchSearchAnalyzer,
                auto_generate_synonyms_phrase_query: false,
                fuzziness: 'AUTO',
                fuzzy_transpositions: true,
              },
            },
          ],
          filter: filters,
        },
      },
    };

    const response = await this.request(`/${this.index()}/_search`, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Elasticsearch 检索失败：HTTP ${response.status}`);
    const payload = (await response.json()) as { hits?: { hits?: Array<{ _id?: string; _score?: number; _source?: Record<string, unknown> }> } };
    const hits = payload.hits?.hits ?? [];

    return hits
      .map((hit) => {
        const source = hit._source ?? {};
        return {
          chunkId: String(source.chunk_id ?? hit._id ?? ''),
          documentId: String(source.document_id ?? ''),
          title: source.title as string | undefined,
          section: source.section as string | undefined,
          page: (source.page as number | null | undefined) ?? null,
          content: String(source.content ?? ''),
          score: Number(hit._score ?? 0),
        };
      })
      .filter((item) => Boolean(item.chunkId));
  }

  async setDocumentPublished(documentId: string, published: boolean): Promise<void> {
    if (!this.configured) return;
    await this.ensureIndex();
    // refresh=true 必需：批量写入后默认 1s 才可见，紧跟其后的 update_by_query 会匹配不到刚写入的切片，
    // 导致「已发布」标记丢失、召回全 0（本次地市入库踩到的坑）。
    const response = await this.request(`/${this.index()}/_update_by_query?refresh=true`, {
      method: 'POST',
      body: JSON.stringify({
        script: { source: 'ctx._source.published = params.published', params: { published: Boolean(published) } },
        query: { term: { document_id: String(documentId) } },
      }),
    });
    if (!response.ok) throw new Error(`Elasticsearch 更新发布状态失败：HTTP ${response.status}`);
  }

  async deleteDocument(documentId: string): Promise<void> {
    if (!this.configured) return;
    // 同样需要 refresh=true，否则删除后立刻重新入库会残留旧切片。
    const response = await this.request(`/${this.index()}/_delete_by_query?refresh=true`, {
      method: 'POST',
      body: JSON.stringify({ query: { term: { document_id: String(documentId) } } }),
    });
    if (!response.ok) throw new Error(`Elasticsearch 删除文档失败：HTTP ${response.status}`);
  }
}

export const elasticsearchKeywordSearch = new ElasticsearchKeywordSearch();

export type SparseBackend = 'pg_trgm' | 'elasticsearch' | 'pg_trgm_fallback';

/** A/B 灰度期间的稀疏臂分发统计，按"实际生效臂"（含 ES 失败后的 pg_trgm_fallback）累计。 */
export interface ArmStats {
  total: number;
  elasticsearch: number;
  pg_trgm: number;
  pg_trgm_fallback: number;
}

/**
 * 稀疏检索后端选择：pg_trgm、elasticsearch 或基于 query 哈希的确定性 A/B 分流。
 * ES 作为实验臂，失败时回落到 pg_trgm 并记录回落臂名。
 */
export class KeywordSearchRouter {
  constructor(
    private readonly es: ElasticsearchKeywordSearch,
    private readonly trgmSearch: (
      query: string,
      regions: string[] | null,
      knowledgeBaseId: string | null,
      limit: number,
      minScore: number,
    ) => Promise<KeywordHit[]>,
    private armStats: ArmStats = { total: 0, elasticsearch: 0, pg_trgm: 0, pg_trgm_fallback: 0 },
  ) {}

  /** 当前 A/B 分流统计（按实际生效臂累计，含 ES 失败回落）。 */
  getArmStats(): ArmStats {
    return { ...this.armStats };
  }

  /** 重置统计（评测/压测前后清理，避免污染真实流量计数）。 */
  resetArmStats(): void {
    this.armStats = { total: 0, elasticsearch: 0, pg_trgm: 0, pg_trgm_fallback: 0 };
  }

  chooseBackend(query: string, variant?: string | null): SparseBackend {
    const requested = (variant ?? config.ragSparseBackend ?? 'pg_trgm').trim().toLowerCase();
    if (requested === 'pg_trgm' || requested === 'elasticsearch') return requested;
    if (requested !== 'ab') return 'pg_trgm';
    const bucket = Number.parseInt(createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8), 16) % 100;
    return bucket < config.ragAbEsPercent ? 'elasticsearch' : 'pg_trgm';
  }

  async search(
    query: string,
    options: {
      regions?: string[] | null;
      knowledgeBaseId?: string | null;
      limit: number;
      minScore: number;
      variant?: string | null;
    },
  ): Promise<{ hits: KeywordHit[]; backend: SparseBackend }> {
    let backend = this.chooseBackend(query, options.variant);
    let hits: KeywordHit[];
    if (backend === 'elasticsearch') {
      if (this.es.configured) {
        try {
          hits = await this.es.search(query, {
            regions: options.regions,
            knowledgeBaseId: options.knowledgeBaseId,
            limit: options.limit,
          });
          backend = 'elasticsearch';
        } catch {
          backend = 'pg_trgm_fallback';
          hits = await this.trgmSearch(
            query,
            options.regions ?? null,
            options.knowledgeBaseId ?? null,
            options.limit,
            options.minScore,
          );
        }
      } else {
        backend = 'pg_trgm_fallback';
        hits = await this.trgmSearch(
          query,
          options.regions ?? null,
          options.knowledgeBaseId ?? null,
          options.limit,
          options.minScore,
        );
      }
    } else {
      hits = await this.trgmSearch(
        query,
        options.regions ?? null,
        options.knowledgeBaseId ?? null,
        options.limit,
        options.minScore,
      );
    }
    // 按"实际生效臂"累计：ES 臂在 configured 失败/未配置时记为 pg_trgm_fallback。
    this.armStats.total += 1;
    this.armStats[backend] += 1;
    return { hits, backend };
  }
}
