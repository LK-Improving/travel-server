/**
 * 混合检索：稠密向量召回 + 稀疏关键字召回 + RRF 融合 + Cross-encoder 精排。
 * 对齐 Python 版 app/services/rag.py。
 * 任一路失败都降级而不是中断检索：稀疏臂失败退回纯向量，精排失败退回融合顺序。
 */
import { config } from '../config';
import { elasticsearchKeywordSearch, KeywordSearchRouter, type SparseBackend } from '../infra/elasticsearch';
import {
  fetchProjectChunkSources,
  fetchPublishedChunkSources,
  searchChunksByKeyword,
} from '../repositories/knowledge';
import { embedQuery, embeddingIdentity, rerank } from './llm';
import { rewriteQueryForSparse } from './queryRewrite';
import { milvusVectorStore } from './vectorStore';

// 切片时识别 URL，避免把链接从中间切断（URL 碎片会让模型编造链接）。
const URL_PATTERN = /https?:\/\/[^\s\u4e00-\u9fff"'<>\uff08\uff09\u3010\u3011]+/g;

export interface RetrievalSource {
  chunkId: string;
  documentId: string;
  title: string;
  section: string | null;
  page: number | null;
  content: string;
  similarity?: number;
  denseScore?: number | null;
  rrfScore?: number;
  rerankScore?: number;
  sparseBackend?: SparseBackend | 'disabled' | 'failed';
}

export interface RetrievalResult {
  success: boolean;
  data: RetrievalSource[];
  fallback: boolean;
  reason: string | null;
  message: string;
}

/** 按句子边界切分，且保证不切断 URL。 */
export function splitText(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split(/\s+/)
    .join(' ')
    .trim();
  if (!normalized) return [];

  const size = Math.max(200, Math.trunc(chunkSize));
  const overlap = Math.min(Math.max(0, Math.trunc(chunkOverlap)), Math.floor(size / 3));
  const urlSpans: Array<[number, number]> = [];
  for (const match of normalized.matchAll(URL_PATTERN)) {
    if (match.index !== undefined) urlSpans.push([match.index, match.index + match[0].length]);
  }

  const enclosingUrl = (position: number): [number, number] | null => {
    for (const [spanStart, spanEnd] of urlSpans) {
      if (spanStart < position && position < spanEnd) return [spanStart, spanEnd];
    }
    return null;
  };

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let hardEnd = Math.min(start + size, normalized.length);
    const tailSpan = enclosingUrl(hardEnd);
    if (tailSpan) hardEnd = Math.min(tailSpan[1], normalized.length);

    const window = normalized.slice(start, hardEnd);
    let end = hardEnd;
    for (const separator of ['\n\n', '\n', '。', '！', '？', '.', '!', '?']) {
      let position = window.lastIndexOf(separator);
      while (position > size * 0.55 && enclosingUrl(start + position + separator.length)) {
        position = window.lastIndexOf(separator, position - 1);
      }
      if (position > size * 0.55) {
        end = start + position + separator.length;
        break;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;

    let nextStart = Math.max(end - overlap, start + 1);
    const overlapSpan = enclosingUrl(nextStart);
    if (overlapSpan) nextStart = Math.min(overlapSpan[1], end);
    start = Math.max(nextStart, start + 1);
  }
  return chunks.filter(Boolean);
}

/**
 * RRF 融合多路召回。每个排名列表按 1/(k+rank) 累加，按总分降序。
 * 只看名次不看量纲（余弦相似度 vs 三元组相似度），无需归一化。
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((chunkId, rank) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([chunkId]) => chunkId);
}

function rrfScores(orderedIds: string[], k: number): Map<string, number> {
  const scores = new Map<string, number>();
  orderedIds.forEach((chunkId, rank) => scores.set(chunkId, 1 / (k + rank + 1)));
  return scores;
}

export class RagService {
  constructor(
    private readonly keywordRouter: KeywordSearchRouter = new KeywordSearchRouter(
      elasticsearchKeywordSearch,
      // 仓储层返回的是带来源信息的 ChunkSource，这里收敛成路由层要的 KeywordHit 形状。
      async (query, regions, knowledgeBaseId, limit, minScore) => {
        const hits = await searchChunksByKeyword(query, regions, knowledgeBaseId, limit, minScore);
        return hits.map((hit) => ({
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          title: hit.title,
          section: hit.section ?? undefined,
          page: hit.page,
          content: hit.content,
          score: hit.score,
        }));
      },
    ),
  ) {}

  async retrieve(
    query: string,
    options: {
      regions?: string[] | null;
      knowledgeBaseId?: string | null;
      limit?: number;
      threshold?: number | null;
      sparseVariant?: string | null;
    } = {},
  ): Promise<RetrievalSource[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) throw new Error('query 不能为空');

    const limit = options.limit ?? config.ragMatchCount;
    const minimum = options.threshold ?? config.ragSimilarityThreshold;

    // 1) 稠密向量召回
    const embedding = await embedQuery(cleanQuery);
    const hits = await milvusVectorStore.searchLegacy(embedding, {
      regions: options.regions ?? [],
      knowledgeBaseId: options.knowledgeBaseId,
      limit: Math.max(config.ragDenseTopK, limit),
    });
    const vectorHits = hits.filter((hit) => Number(hit.distance ?? 0) >= minimum);
    const denseIds = vectorHits.map((hit) => String(hit.chunk_id));
    const denseScores = new Map(vectorHits.map((hit) => [String(hit.chunk_id), Number(hit.distance ?? 0)]));

    // 2) 稀疏关键字召回
    let sparseIds: string[] = [];
    let sparseBackend: SparseBackend | 'disabled' | 'failed' = 'disabled';
    if (config.ragHybridEnabled) {
      // 改写只喂稀疏臂；稠密臂继续用原句（语义检索本就擅长长句）。
      const sparseQuery = await rewriteQueryForSparse(cleanQuery);
      try {
        const { hits: rows, backend } = await this.keywordRouter.search(cleanQuery, {
          regions: options.regions ?? null,
          knowledgeBaseId: options.knowledgeBaseId ?? null,
          limit: config.ragSparseTopK,
          minScore: config.ragSparseMinScore,
          variant: options.sparseVariant ?? null,
          sparseQuery,
        });
        sparseIds = rows.map((row) => String(row.chunkId));
        sparseBackend = backend;
      } catch {
        sparseIds = [];
        sparseBackend = 'failed';
      }
    }

    // 3) RRF 融合
    const orderedIds = sparseIds.length
      ? reciprocalRankFusion([denseIds, sparseIds], config.ragRrfK)
      : denseIds;
    if (!orderedIds.length) return [];

    // 4) 回表取原文（published 二次校验），保持候选顺序
    const candidateIds = orderedIds.slice(0, Math.max(config.ragDenseTopK, config.ragSparseTopK));
    const metadata = await fetchPublishedChunkSources(candidateIds);
    const byId = new Map(metadata.map((row) => [row.chunkId, row]));
    const candidates: RetrievalSource[] = candidateIds
      .filter((id) => byId.has(id))
      .map((id) => ({
        ...byId.get(id)!,
        denseScore: denseScores.get(id) ?? null,
        sparseBackend,
      }));
    if (!candidates.length) return [];

    // 5) Cross-encoder 精排
    if (config.ragRerankEnabled) {
      try {
        const ranked = await rerank(
          cleanQuery,
          candidates.map((item) => item.content),
          limit,
        );
        const reranked = ranked
          .slice(0, limit)
          .map((item) => ({
            ...candidates[item.index],
            rerankScore: item.score,
            similarity: item.score,
          }))
          .filter(Boolean);
        if (reranked.length) return reranked;
      } catch {
        /* 精排失败退回融合顺序 */
      }
    }

    return candidates.slice(0, limit).map((source) => ({
      ...source,
      similarity: source.similarity ?? source.denseScore ?? 0,
    }));
  }

  /**
   * 项目会话检索：只搜索冻结版本绑定的知识库。
   * 没有 legacy collection 降级路径，每次搜索都必须解析租户 + 知识库的活动索引。
   */
  async retrieveProject(
    query: string,
    options: {
      tenantId: string;
      knowledgeBaseIds: string[];
      regions?: string[] | null;
      limit?: number;
      threshold?: number | null;
      sparseVariant?: string | null;
    },
  ): Promise<RetrievalSource[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) throw new Error('query 不能为空');

    const allowedKbs = [...new Set(options.knowledgeBaseIds.map(String).filter(Boolean))];
    if (!allowedKbs.length) return [];

    const safeLimit = Math.min(Math.max(Number(options.limit ?? 5), 1), 20);
    const minimum = options.threshold ?? config.ragSimilarityThreshold;
    const embedding = await embedQuery(cleanQuery);
    const identity = embeddingIdentity();
    const candidates: RetrievalSource[] = [];

    // 改写一次即可（多知识库循环里复用），未开启时 rewriteQueryForSparse 直接返回原句。
    const sparseQuery = await rewriteQueryForSparse(cleanQuery);

    for (const knowledgeBaseId of allowedKbs) {
      let denseScores = new Map<string, number>();
      try {
        const hits = await milvusVectorStore.search({
          tenantId: options.tenantId,
          knowledgeBaseId,
          embeddingModel: identity.model,
          embeddingDimension: identity.dimension,
          embedding,
          regions: options.regions ?? [],
          limit: safeLimit,
        });
        denseScores = new Map(
          hits
            .filter((hit) => Number(hit.distance ?? 0) >= minimum)
            .map((hit) => [hit.chunkId, Number(hit.distance ?? 0)]),
        );
      } catch {
        // 单个知识库索引异常不应拖垮整个项目会话。
        if (!config.ragHybridEnabled) continue;
      }
      const denseIds = [...denseScores.keys()];
      if (!denseIds.length && !config.ragHybridEnabled) continue;

      let sparseIds: string[] = [];
      let sparseBackend: SparseBackend | 'disabled' | 'failed' = 'disabled';
      if (config.ragHybridEnabled) {
        try {
          const { hits: rows, backend } = await this.keywordRouter.search(cleanQuery, {
            regions: options.regions ?? null,
            knowledgeBaseId,
            limit: Math.max(config.ragSparseTopK, safeLimit),
            minScore: config.ragSparseMinScore,
            variant: options.sparseVariant ?? null,
            sparseQuery,
          });
          sparseIds = rows.map((row) => row.chunkId).filter(Boolean);
          sparseBackend = backend;
        } catch {
          sparseBackend = 'failed';
        }
      }

      const orderedIds = sparseIds.length
        ? reciprocalRankFusion([denseIds, sparseIds], config.ragRrfK)
        : denseIds;
      if (!orderedIds.length) continue;

      const scores = rrfScores(orderedIds, config.ragRrfK);
      const rows = await fetchProjectChunkSources(
        options.tenantId,
        knowledgeBaseId,
        orderedIds.slice(0, Math.max(config.ragDenseTopK, config.ragSparseTopK)),
      );
      for (const row of rows) {
        const rrfScore = scores.get(row.chunkId);
        if (rrfScore === undefined) continue;
        candidates.push({
          ...row,
          similarity: denseScores.get(row.chunkId) ?? 0,
          rrfScore,
          sparseBackend,
        });
      }
    }

    candidates.sort((a, b) => Number(b.rrfScore ?? 0) - Number(a.rrfScore ?? 0));

    const unique: RetrievalSource[] = [];
    const seen = new Set<string>();
    for (const source of candidates) {
      if (!source.chunkId || seen.has(source.chunkId)) continue;
      seen.add(source.chunkId);
      unique.push(source);
      if (unique.length >= safeLimit) break;
    }

    if (config.ragRerankEnabled && unique.length) {
      try {
        const ranked = await rerank(
          cleanQuery,
          unique.map((item) => item.content),
          safeLimit,
        );
        const reranked = ranked
          .slice(0, safeLimit)
          .map((item) => ({ ...unique[item.index], rerankScore: item.score, similarity: item.score }))
          .filter(Boolean);
        if (reranked.length) return reranked;
      } catch {
        /* 精排失败退回 RRF 顺序 */
      }
    }
    return unique;
  }

  async search(
    query: string,
    matchCount?: number | null,
    threshold?: number | null,
    sparseVariant?: string | null,
  ): Promise<RetrievalSource[]> {
    return this.retrieve(query, {
      limit: matchCount ?? config.ragMatchCount,
      threshold,
      sparseVariant,
    });
  }

  /** 检索失败时返回空结果 + fallback 标记，前端走空状态而不是错误态。 */
  async searchWithFallback(
    query: string,
    options: {
      regions?: string[];
      knowledgeBaseId?: string | null;
      matchCount?: number | null;
      threshold?: number | null;
      sparseVariant?: string | null;
    } = {},
  ): Promise<RetrievalResult> {
    try {
      const sources = await this.retrieve(query, {
        regions: options.regions ?? [],
        knowledgeBaseId: options.knowledgeBaseId ?? null,
        limit: options.matchCount ?? config.ragMatchCount,
        threshold: options.threshold ?? null,
        sparseVariant: options.sparseVariant ?? null,
      });
      return {
        success: true,
        data: sources,
        fallback: false,
        reason: sources.length ? null : 'NO_MATCH',
        message: sources.length ? '' : '未检索到满足条件的知识库片段',
      };
    } catch {
      return {
        success: true,
        data: [],
        fallback: true,
        reason: 'RETRIEVAL_FAILED',
        message: '知识库检索暂时不可用',
      };
    }
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      success: true,
      ...(await milvusVectorStore.health()),
      sparseArmStats: this.keywordRouter.getArmStats(),
    };
  }

  /** A/B 灰度期间读取稀疏臂分发统计（实际生效臂，含 ES 失败回落）。 */
  get sparseArmStats() {
    return this.keywordRouter.getArmStats();
  }

  /** 重置 A/B 臂统计（评测/压测前后清理用）。 */
  resetSparseArmStats(): void {
    this.keywordRouter.resetArmStats();
  }
}

export const ragService = new RagService();
