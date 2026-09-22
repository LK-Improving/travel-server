/**
 * 长自然语言查询改写（对应 eval/es-vs-pg_trgm-comparison.md §7.2）。
 *
 * 动机：稀疏检索（ES BM25 / pg_trgm）对"整段口语化长问句"召回差（ES-only 长自然语言 Recall@5 仅 0.692），
 * 因为长句里的停用词、语气词稀释了关键词权重。改写把长句压缩成"实体 + 意图"的短查询，只喂给稀疏臂；
 * 稠密臂仍用原句（语义检索本身擅长长句，改了反而丢信息）。
 *
 * 安全边界（重要）：
 * - 默认关闭（RAG_QUERY_REWRITE_ENABLED=false），开启才生效；
 * - 任何异常（缺配置、超时、HTTP 错误、返回为空、改写后不比原句短）一律静默回退原句，绝不中断检索；
 * - 进程内 memo，避免 retrieveProject 多知识库循环里对同一 query 重复付费调用。
 */
import { config } from '../config';
import { chatCredentials } from './llm';

/** memo 上限，超出按插入顺序淘汰最旧项。 */
const MEMO_LIMIT = 256;

const memo = new Map<string, string>();

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

const SYSTEM_PROMPT = '你是检索查询改写器。只输出一行关键词查询，不要解释，不要推理过程。';

// 提示刻意保持简短：推理型模型（如 deepseek-flash）会先消耗 reasoning token，
// 提示越长、推理越久，越容易把 max_tokens 吃光导致正文为空。
const USER_PROMPT = '把用户问题压缩成关键词检索查询，空格分隔，只保留实体与意图，不要标点，只输出一行。\n\n问题：';

function remember(key: string, value: string): void {
  if (memo.size >= MEMO_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, value);
}

/** 清洗模型输出：去代码块/换行/标点，压缩空白；结果必须"更短且非空"，否则回退原句。 */
function sanitize(raw: string, original: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[，。！？；：、"'`「」『』（）()【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return original;
  // 改写没变短说明模型在复述原句，用它反而可能丢词——宁可用原句。
  if (cleaned.length >= original.length) return original;
  return cleaned;
}

/**
 * 为稀疏检索改写查询。未开启 / 过短 / 失败时原样返回。
 */
export async function rewriteQueryForSparse(query: string): Promise<string> {
  const original = query.trim();
  if (!config.ragQueryRewriteEnabled) return original;
  if (!original) return original;
  if (original.length < config.ragQueryRewriteMinChars) return original;

  const cached = memo.get(original);
  if (cached !== undefined) return cached;

  try {
    const credentials = chatCredentials();
    const model = config.ragQueryRewriteModel || credentials.model;
    if (!credentials.apiKey || !credentials.baseUrl || !model) return original;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
    let result = original;
    try {
      const response = await fetch(`${credentials.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          // 必须留足预算：推理型模型会先输出 reasoning_content，
          // 128 会被推理吃光导致 content 为空（实测踩到），改写就静默失效了。
          max_tokens: Math.max(512, config.modelMaxTokens > 0 ? Math.min(config.modelMaxTokens, 1024) : 512),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${USER_PROMPT}${original}` },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`改写服务返回 HTTP ${response.status}`);
      const payload = (await response.json()) as ChatCompletionResponse;
      result = sanitize(String(payload.choices?.[0]?.message?.content ?? ''), original);
    } finally {
      clearTimeout(timer);
    }
    remember(original, result);
    return result;
  } catch {
    // 改写是"增益项"，失败绝不能影响检索可用性。
    return original;
  }
}

/** 仅测试/评测用：清空 memo。 */
export function clearRewriteMemo(): void {
  memo.clear();
}
