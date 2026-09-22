/**
 * 运行时配置。密钥只在运行时从环境变量读取，不写入代码或版本库。
 * 与 Python 版 app/core/config.py 逐项对齐。
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(currentDir, '../.env') });

export function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envFloat(name: string, fallback: number): number {
  const parsed = Number.parseFloat(env(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(name: string, fallback = true): boolean {
  const raw = env(name);
  if (!raw) return fallback;
  return !['false', '0', 'no'].includes(raw.toLowerCase());
}

const LOCAL_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const PRODUCTION_ORIGIN = 'https://travel-web-ruddy-kappa.vercel.app';

function allowedOrigins(): Set<string> {
  const configured = env('CORS_ORIGINS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set<string>([...LOCAL_ORIGINS, PRODUCTION_ORIGIN, ...configured]);
}

/** 模型供应商凭据。保持与 Node 版一致的环境变量命名。 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function providerConfig(prefix: string, defaultModel = ''): ProviderConfig {
  return {
    apiKey: env(`${prefix}_API_KEY`),
    baseUrl: env(`${prefix}_BASE_URL`).replace(/\/+$/, ''),
    model: env(`${prefix}_MODEL`, defaultModel),
  };
}

export const PROVIDER_PREFIXES = ['DEEPSEEK', 'GJLD', 'XIAOMI'] as const;
export type ProviderName = (typeof PROVIDER_PREFIXES)[number];

export const config = {
  appName: 'Travel RAG Platform',
  port: envInt('PORT', 8000),

  // ---------- 模型 ----------
  modelProvider: (env('MODEL_PROVIDER') || env('MODEL_PROVIDE') || 'DEEPSEEK').toUpperCase(),
  modelMaxTokens: envInt('MODEL_MAX_TOKENS', 1600),
  plannerModel: env('PLANNER_MODEL') || env('TOOL_MODEL'),
  answerModel: env('ANSWER_MODEL'),
  intentModel: env('INTENT_MODEL'),
  summaryModel: env('SUMMARY_MODEL'),
  memoryJudgeModel: env('MEMORY_JUDGE_MODEL'),
  memoryKeepMessages: envInt('MEMORY_KEEP_MESSAGES', 12),
  memoryRedundantThreshold: envFloat('MEMORY_REDUNDANT_THRESHOLD', 0.92),
  memoryNovelThreshold: envFloat('MEMORY_NOVEL_THRESHOLD', 0.75),
  // 用户长短记忆（Node 版 favorites/memories 模块沿用）的参数。
  memoryMessageLimit: envInt('MEMORY_MESSAGE_LIMIT', 6),
  memorySummaryThreshold: envInt('MEMORY_SUMMARY_THRESHOLD', 20),
  memoryKeepLimit: envInt('MEMORY_KEEP_LIMIT', 50),
  llmTimeoutMs: envInt('LLM_TIMEOUT_MS', 120000),
  llmMaxRetries: envInt('LLM_MAX_RETRIES', 1),
  modelFallback: env('MODEL_FALLBACK') || env('FALLBACK_MODEL'),
  modelRateLimitPerMinute: envInt('MODEL_RATE_LIMIT_PER_MINUTE', 60),
  modelCircuitFailureThreshold: envInt('MODEL_CIRCUIT_FAILURE_THRESHOLD', 3),
  modelCircuitResetSeconds: envInt('MODEL_CIRCUIT_RESET_SECONDS', 30),
  modelCacheTtlSeconds: envInt('MODEL_CACHE_TTL_SECONDS', 0),
  modelCacheMaxEntries: envInt('MODEL_CACHE_MAX_ENTRIES', 512),
  modelInputCostCnyPer1k: envFloat('MODEL_INPUT_COST_CNY_PER_1K', 0),
  modelOutputCostCnyPer1k: envFloat('MODEL_OUTPUT_COST_CNY_PER_1K', 0),

  // ---------- RAG ----------
  ragChunkSize: envInt('RAG_CHUNK_SIZE', 800),
  ragChunkOverlap: envInt('RAG_CHUNK_OVERLAP', 120),
  ragMatchCount: envInt('RAG_MATCH_COUNT', 5),
  ragSimilarityThreshold: envFloat('RAG_SIMILARITY_THRESHOLD', 0.55),
  ragHybridEnabled: envBool('RAG_HYBRID_ENABLED', true),
  ragDenseTopK: envInt('RAG_DENSE_TOP_K', 20),
  ragSparseTopK: envInt('RAG_SPARSE_TOP_K', 20),
  ragRrfK: envInt('RAG_RRF_K', 60),
  // 长自然语言查询改写（§7.2）：把整段口语问题压缩成关键词短查询，只喂给稀疏臂；
  // 稠密臂仍用原句（语义检索本就擅长长句）。默认关闭，失败静默回退原句。
  ragQueryRewriteEnabled: envBool('RAG_QUERY_REWRITE_ENABLED', false),
  ragQueryRewriteMinChars: envInt('RAG_QUERY_REWRITE_MIN_CHARS', 24),
  ragQueryRewriteModel: env('RAG_QUERY_REWRITE_MODEL'),
  ragSparseMinScore: envFloat('RAG_SPARSE_MIN_SCORE', 0.05),
  ragSparseBackend: env('RAG_SPARSE_BACKEND', 'pg_trgm').toLowerCase() as 'pg_trgm' | 'elasticsearch' | 'ab',
  ragAbEsPercent: envInt('RAG_AB_ES_PERCENT', 50),
  ragRerankEnabled: envBool('RAG_RERANK_ENABLED', true),
  rerankModel: env('RERANK_MODEL', 'BAAI/bge-reranker-v2-m3'),
  agentSseHeartbeatMs: envInt('AGENT_SSE_HEARTBEAT_MS', 15000),

  // ---------- Ollama ----------
  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
  ollamaChatModel: env('OLLAMA_CHAT_MODEL'),
  ollamaEmbeddingModel: env('OLLAMA_EMBEDDING_MODEL'),
  ollamaApiKey: env('OLLAMA_API_KEY', 'ollama'),

  // ---------- Embedding ----------
  embeddingDimension: envInt('EMBEDDING_DIMENSION', 1024),
  embeddingApiKey: env('EMBEDDING_API_KEY'),
  embeddingBaseUrl: env('EMBEDDING_BASE_URL').replace(/\/+$/, ''),
  embeddingModel: env('EMBEDDING_MODEL'),
  embeddingBatchSize: envInt('EMBEDDING_BATCH_SIZE', 16),
  embeddingTimeoutMs: envInt('EMBEDDING_TIMEOUT_MS', 60000),

  // ---------- Milvus ----------
  milvusHost: env('MILVUS_HOST', '127.0.0.1'),
  milvusPort: envInt('MILVUS_PORT', 19530),
  milvusCollection: env('MILVUS_COLLECTION', 'travel_document_chunks_v2'),
  milvusMetricType: env('MILVUS_METRIC_TYPE', 'COSINE').toUpperCase() as 'COSINE' | 'L2' | 'IP',
  milvusIndexType: env('MILVUS_INDEX_TYPE', 'HNSW').toUpperCase() as 'HNSW' | 'IVF_FLAT' | 'FLAT',
  milvusSearchEf: envInt('MILVUS_SEARCH_EF', 64),
  milvusUser: env('MILVUS_USER'),
  milvusPassword: env('MILVUS_PASSWORD'),

  // ---------- Redis / 队列 ----------
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379/0'),
  documentQueueName: env('DOCUMENT_QUEUE_NAME', 'travel-documents'),

  // ---------- 对象存储 ----------
  objectStorageEndpoint: env('OBJECT_STORAGE_ENDPOINT'),
  objectStorageAccessKey: env('OBJECT_STORAGE_ACCESS_KEY'),
  objectStorageSecretKey: env('OBJECT_STORAGE_SECRET_KEY'),
  objectStorageBucket: env('OBJECT_STORAGE_BUCKET', 'travel-ai-documents'),
  objectStorageSecure: envBool('OBJECT_STORAGE_SECURE', false),
  objectStorageRegion: env('OBJECT_STORAGE_REGION'),

  // ---------- Elasticsearch ----------
  elasticsearchUrl: env('ELASTICSEARCH_URL').replace(/\/+$/, ''),
  elasticsearchApiKey: env('ELASTICSEARCH_API_KEY'),
  elasticsearchIndex: env('ELASTICSEARCH_INDEX', 'travel-rag-chunks-v1'),
  elasticsearchTimeoutMs: envInt('ELASTICSEARCH_TIMEOUT_MS', 8000),
  // 中文分词器：ik_max_word（建索引，最细粒度）/ ik_smart（查询，粗粒度）需 ES 装 IK 插件；
  // 若未装 IK，可改为 smartcn（ES 自带）或 standard。两者通过 env 切换，无需改代码。
  elasticsearchAnalyzer: env('ELASTICSEARCH_ANALYZER', 'ik_max_word'),
  elasticsearchSearchAnalyzer: env('ELASTICSEARCH_SEARCH_ANALYZER', 'ik_smart'),

  // ---------- 上传与 Excel 安全限制 ----------
  uploadMaxBytes: envInt('UPLOAD_MAX_BYTES', 20 * 1024 * 1024),
  excelMaxSheets: envInt('EXCEL_MAX_SHEETS', 50),
  excelMaxRows: envInt('EXCEL_MAX_ROWS', 200_000),
  excelMaxColumns: envInt('EXCEL_MAX_COLUMNS', 500),
  excelMaxCells: envInt('EXCEL_MAX_CELLS', 2_000_000),
  excelMaxUncompressedBytes: envInt('EXCEL_MAX_UNCOMPRESSED_BYTES', 256 * 1024 * 1024),
  excelMaxZipEntries: envInt('EXCEL_MAX_ZIP_ENTRIES', 10_000),

  // ---------- 工具与高德 ----------
  toolTimeoutMs: envInt('TOOL_TIMEOUT_MS', 8000),
  amapApiKey: env('AMAP_API_KEY'),
  amapMcpUrl: env('AMAP_MCP_URL', 'https://mcp.amap.com/mcp'),
  amapMcpApiKey: env('AMAP_MCP_API_KEY') || env('AMAP_API_KEY'),
  amapMcpEnabled: envBool('AMAP_MCP_ENABLED', false),

  // ---------- 鉴权 ----------
  jwtSecret: env('AUTH_TOKEN_SECRET') || env('JWT_SECRET'),
  jwtExpiresInSeconds: envInt('JWT_EXPIRES_IN_SECONDS', 604800),
} as const;

/** 生效的 embedding 模型名，与 llm.ts 中的选择逻辑保持一致。 */
export function activeEmbeddingModel(): string {
  return config.modelProvider === 'OLLAMA' ? config.ollamaEmbeddingModel : config.embeddingModel;
}

export function getAllowedOrigins(): Set<string> {
  return allowedOrigins();
}

export function provider(name: ProviderName): ProviderConfig {
  return providerConfig(name);
}

/** 与 Python 版 Settings.auth_database_url 对齐：AUTH_DB_URL > PG_URL > DATABASE_URL > 拼接。 */
export function authDatabaseUrl(): string {
  const direct = env('AUTH_DB_URL') || env('PG_URL') || env('DATABASE_URL');
  if (direct) return direct;

  const host = env('AUTH_DB_HOST', 'localhost');
  const port = env('AUTH_DB_PORT', '5432');
  const name = env('AUTH_DB_NAME', 'travel');
  const user = env('AUTH_DB_USER', 'postgres');
  const password = env('AUTH_DB_PASSWORD');
  const ssl = env('AUTH_DB_SSL', 'false').toLowerCase() === 'true';
  const credentials = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgresql://${credentials}@${host}:${port}/${name}${ssl ? '?sslmode=require' : ''}`;
}

export function agentCheckpointDatabaseUrl(): string {
  return env('AGENT_CHECKPOINT_DB_URL') || authDatabaseUrl();
}

export function validateRuntimeConfig(): void {
  if (config.embeddingDimension <= 0) throw new Error('EMBEDDING_DIMENSION 必须为正整数');
  if (config.milvusPort < 1 || config.milvusPort > 65535) throw new Error('MILVUS_PORT 必须在 1-65535 之间');
  if (!config.milvusCollection || config.milvusCollection.length > 255) throw new Error('MILVUS_COLLECTION 配置无效');
  if (config.uploadMaxBytes <= 0) throw new Error('UPLOAD_MAX_BYTES 必须为正整数');
  const excelLimits = [
    config.excelMaxSheets,
    config.excelMaxRows,
    config.excelMaxColumns,
    config.excelMaxCells,
    config.excelMaxUncompressedBytes,
    config.excelMaxZipEntries,
  ];
  if (excelLimits.some((limit) => limit <= 0)) throw new Error('Excel 安全限制必须为正整数');
  if (!['pg_trgm', 'elasticsearch', 'ab'].includes(config.ragSparseBackend)) {
    throw new Error('RAG_SPARSE_BACKEND 必须为 pg_trgm、elasticsearch 或 ab');
  }
  if (config.ragAbEsPercent < 0 || config.ragAbEsPercent > 100) throw new Error('RAG_AB_ES_PERCENT 必须在 0-100 之间');
  if (
    config.modelRateLimitPerMinute <= 0 ||
    config.modelCircuitFailureThreshold <= 0 ||
    config.modelCircuitResetSeconds <= 0 ||
    config.modelCacheMaxEntries <= 0
  ) {
    throw new Error('模型限流、熔断和缓存配置必须为正数');
  }
  if (config.modelCacheTtlSeconds < 0 || config.modelInputCostCnyPer1k < 0 || config.modelOutputCostCnyPer1k < 0) {
    throw new Error('模型缓存 TTL 和成本配置不能为负数');
  }
}
