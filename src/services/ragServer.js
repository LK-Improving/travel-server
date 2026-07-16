import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { OpenAIEmbeddings } from '@langchain/openai';
import TravelServer from './travelServer.js';
import SupabaseRagStore from './supabaseRagStore.js';
import { getSupabaseClient, getSupabaseConfig } from './supabaseClient.js';
import 'dotenv/config.js';

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function splitText(text, chunkSize, chunkOverlap) {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const size = Math.max(200, Math.floor(chunkSize));
  const overlap = Math.min(Math.max(0, Math.floor(chunkOverlap)), Math.floor(size / 3));
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(start + size, normalized.length);
    const windowText = normalized.slice(start, hardEnd);
    const breakCandidates = ['\n\n', '\n', '。', '！', '？', '.', '!', '?'];
    let relativeEnd = -1;

    for (const separator of breakCandidates) {
      const position = windowText.lastIndexOf(separator);
      if (position > size * 0.55) {
        relativeEnd = position + separator.length;
        break;
      }
    }

    const end = relativeEnd > 0 ? start + relativeEnd : hardEnd;
    chunks.push(normalized.slice(start, end).trim());

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks.filter(Boolean);
}

function buildContext(sources) {
  if (!sources.length) return '无匹配资料。';

  return sources
    .map((source, index) => {
      const title = source.title ? `《${source.title}》` : '未命名资料';
      const similarity = Number(source.similarity || 0).toFixed(3);
      return `[${index + 1}] ${title} chunk=${source.chunk_index} similarity=${similarity}\n${source.chunk}`;
    })
    .join('\n\n');
}

function formatRetrievalError(error) {
  const message = error?.message || '向量检索失败';
  return {
    fallback: true,
    reason: 'RETRIEVAL_FAILED',
    message,
  };
}

class RagServer {
  constructor() {
    this.embeddings = null;
  }

  getEmbeddings() {
    if (this.embeddings) return this.embeddings;

    const apiKey =
      cleanEnv(process.env.EMBEDDING_API_KEY) ||
      cleanEnv(process.env.GJLD_API_KEY) ||
      cleanEnv(process.env.DEEPSEEK_API_KEY);
    const baseURL =
      cleanEnv(process.env.EMBEDDING_BASE_URL) ||
      cleanEnv(process.env.GJLD_BASE_URL) ||
      cleanEnv(process.env.DEEPSEEK_BASE_URL);
    const model = cleanEnv(process.env.EMBEDDING_MODEL) || 'BAAI/bge-m3';

    if (!apiKey || !baseURL || !model) {
      throw new Error('缺少 embedding 模型配置');
    }

    this.embeddings = new OpenAIEmbeddings({
      apiKey,
      model,
      timeout: Number(process.env.EMBEDDING_TIMEOUT_MS || 60000),
      batchSize: Number(process.env.EMBEDDING_BATCH_SIZE || 16),
      dimensions: process.env.EMBEDDING_DIMENSIONS ? Number(process.env.EMBEDDING_DIMENSIONS) : undefined,
      configuration: {
        baseURL,
      },
    });

    return this.embeddings;
  }

  async addDocument({ title = '', content, metadata = {}, chunkSize, chunkOverlap }) {
    if (!content || typeof content !== 'string') {
      throw new Error('content 不能为空');
    }

    const chunks = splitText(
      content,
      toPositiveNumber(chunkSize, Number(process.env.RAG_CHUNK_SIZE || 800)),
      toPositiveNumber(chunkOverlap, Number(process.env.RAG_CHUNK_OVERLAP || 120)),
    );

    if (!chunks.length) {
      throw new Error('content 没有可入库内容');
    }

    const embeddings = await this.getEmbeddings().embedDocuments(chunks);
    const rows = await SupabaseRagStore.addChunks({
      title: String(title || '').trim(),
      content,
      chunks,
      embeddings,
      metadata,
    });

    return {
      title,
      chunkCount: chunks.length,
      rows,
    };
  }

  async search(query, options = {}) {
    if (!query || typeof query !== 'string') {
      throw new Error('query 不能为空');
    }

    const embedding = await this.getEmbeddings().embedQuery(query);
    return SupabaseRagStore.search({
      embedding,
      matchCount: options.matchCount,
      threshold: options.threshold,
    });
  }

  async searchWithFallback(query, options = {}) {
    try {
      const sources = await this.search(query, options);
      return {
        success: true,
        data: sources,
        fallback: false,
        reason: sources.length ? null : 'NO_MATCH',
        message: sources.length ? '' : '未检索到满足条件的知识库片段',
      };
    } catch (error) {
      console.warn('RAG retrieval fallback:', error);
      return {
        success: true,
        data: [],
        ...formatRetrievalError(error),
      };
    }
  }

  async status() {
    await SupabaseRagStore.init();

    const { url } = getSupabaseConfig();
    const { error, data } = await getSupabaseClient().from('travel_rag_documents').select('id').limit(1);

    if (error) {
      throw new Error(`Supabase REST 检查失败：${error.message}`);
    }

    return {
      success: true,
      supabaseUrl: url,
      table: 'travel_rag_documents',
      restReachable: true,
      sampleDocumentId: data?.[0]?.id || null,
    };
  }

  async chat(message, options = {}, streamCallback) {
    const retrieval = await this.searchWithFallback(message, options);
    const sources = retrieval.data;
    options.onSources?.(sources, retrieval);

    const messages = [
      new SystemMessage(`你是一个专业的旅游规划师。请优先依据参考资料回答用户问题，并保持中文表达清晰、可执行。
如果参考资料不足或知识库检索暂不可用，先简短说明“当前知识库资料不足”，再基于通用旅游知识给出谨慎建议。
回答中不要编造参考资料里没有的票价、开放时间或政策细节。`),
      new HumanMessage(`用户问题：
${message}

检索状态：
${retrieval.fallback ? `${retrieval.reason}: ${retrieval.message}` : retrieval.message || '已完成知识库检索'}

参考资料：
${buildContext(sources)}`),
    ];
    // console.log('messages :>> ', messages);
    try {
      const stream = await TravelServer.llm.stream(messages);
      let fullResponse = '';

      for await (const chunk of stream) {
        const content = chunk.content || '';
        if (content.trim() === '') continue;
        fullResponse += content;
        streamCallback?.(content);
      }

      return {
        success: true,
        reply: fullResponse,
        sources,
        retrieval,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        sources,
        retrieval,
      };
    }
  }
}

export default new RagServer();
