/**
 * OpenAI 兼容的聊天、embedding 与 rerank 接入，含本地 Ollama。
 * 对齐 Python 版 app/services/llm.py + app/integrations/langchain_llm.py。
 */
import { ChatOpenAI } from '@langchain/openai';
import { activeEmbeddingModel, config, env, provider, PROVIDER_PREFIXES, type ProviderName } from '../config';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function providerCredentials(name: string): ProviderCredentials {
  const upper = name.toUpperCase();
  if (upper === 'OLLAMA') {
    return { apiKey: config.ollamaApiKey || 'ollama', baseUrl: config.ollamaBaseUrl, model: config.ollamaChatModel };
  }
  if (!PROVIDER_PREFIXES.includes(upper as ProviderName)) {
    throw new Error(`不支持的模型供应商：${name || '未配置'}`);
  }
  const credentials = provider(upper as ProviderName);
  if (!credentials.apiKey || !credentials.baseUrl || !credentials.model) {
    throw new Error(`${upper} 缺少 apiKey、baseURL 或 chat model 配置`);
  }
  return credentials;
}

export function chatCredentials(name: string = config.modelProvider): ProviderCredentials {
  return providerCredentials(name);
}

/** 构建 LangChain 模型适配器；只是适配各供应商差异，不发起网络请求。 */
export function buildChatModel(
  modelName?: string,
  providerName: string = config.modelProvider,
  options: { temperature?: number; maxTokens?: number } = {},
): ChatOpenAI {
  const credentials = providerCredentials(providerName);
  return new ChatOpenAI({
    model: modelName || credentials.model,
    apiKey: credentials.apiKey,
    configuration: { baseURL: credentials.baseUrl },
    timeout: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? config.modelMaxTokens,
    streaming: true,
  });
}

export function embeddingIdentity(): { model: string; dimension: number } {
  const model = activeEmbeddingModel();
  const dimension = config.embeddingDimension;
  if (!model || dimension <= 0) throw new Error('缺少 embedding 模型配置');
  return { model, dimension };
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>;
}

async function postJson<T>(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function embeddingCredentials(): ProviderCredentials {
  if (config.modelProvider === 'OLLAMA') {
    return {
      apiKey: config.ollamaApiKey || 'ollama',
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaEmbeddingModel,
    };
  }
  return {
    apiKey: config.embeddingApiKey || env('GJLD_API_KEY') || env('DEEPSEEK_API_KEY'),
    baseUrl: config.embeddingBaseUrl || env('GJLD_BASE_URL') || env('DEEPSEEK_BASE_URL'),
    model: config.embeddingModel,
  };
}

/** 批量生成 embedding，并逐条校验维度，避免把错误维度的向量写进 Milvus。 */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const credentials = embeddingCredentials();
  if (!credentials.apiKey || !credentials.baseUrl || !credentials.model) {
    throw new Error('缺少 embedding 模型配置');
  }
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += config.embeddingBatchSize) {
    const batch = texts.slice(index, index + config.embeddingBatchSize);
    const payload = await postJson<EmbeddingResponse>(
      `${credentials.baseUrl}/embeddings`,
      credentials.apiKey,
      { model: credentials.model, input: batch },
      config.embeddingTimeoutMs,
    );
    const rows = (payload.data ?? []).map((item) => (item.embedding ?? []).map((value) => Number(value)));
    if (rows.length !== batch.length) throw new Error('embedding 返回条数与输入不一致');
    vectors.push(...rows);
  }
  for (const vector of vectors) {
    if (vector.length !== config.embeddingDimension) {
      throw new Error(`embedding 维度 ${vector.length} 与配置维度 ${config.embeddingDimension} 不一致`);
    }
  }
  return vectors;
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await embedDocuments([text]))[0];
}

export interface RerankHit {
  index: number;
  score: number;
}

/** Cross-encoder 精排，调用 OpenAI 兼容供应商的 /rerank（如硅基流动 bge-reranker）。 */
export async function rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]> {
  if (!documents.length) return [];
  const apiKey = env('RERANK_API_KEY') || config.embeddingApiKey || env('GJLD_API_KEY');
  const baseUrl = (env('RERANK_BASE_URL') || config.embeddingBaseUrl || env('GJLD_BASE_URL')).replace(/\/+$/, '');
  const model = config.rerankModel;
  if (!apiKey || !baseUrl || !model) throw new Error('缺少 rerank 模型配置');

  const payload = await postJson<RerankResponse>(
    `${baseUrl}/rerank`,
    apiKey,
    {
      model,
      query,
      documents,
      top_n: Math.min(Math.max(Math.trunc(topN), 1), documents.length),
      return_documents: false,
    },
    config.llmTimeoutMs,
  );
  return (payload.results ?? [])
    .filter((item) => item.index !== undefined)
    .map((item) => ({ index: Number(item.index), score: Number(item.relevance_score ?? 0) }));
}

export const llmService = {
  embedDocuments,
  embedQuery,
  embedQueryIdentity: embeddingIdentity,
  embeddingIdentity,
  rerank,
  buildChatModel,
};
