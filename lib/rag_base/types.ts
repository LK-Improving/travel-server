// 意图分类、上下文压缩的共享类型与工具函数（对齐 Python app/rag_base/context_manager.py）。
import type { BaseMessage } from '@langchain/core/messages';

export type IntentName =
  | 'knowledge_qa'
  | 'weather'
  | 'poi'
  | 'route'
  | 'data_query'
  | 'chat'
  | 'clarify'
  | 'unsafe';

export interface IntentPlan {
  intent: IntentName;
  rewritten_query: string;
  slots: Record<string, string>;
  confidence: number;
  needs_retrieval: boolean;
}

export type MemoryDecisionDecision = 'drop' | 'summarize' | 'keep_raw';
export type LostInformationRisk = 'low' | 'medium' | 'high';

export interface MemoryDecision {
  decision: MemoryDecisionDecision;
  protected_facts: string[];
  lost_information_risk: LostInformationRisk;
  confidence: number;
}

export function messageText(message: BaseMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content, null, 0);
  } catch {
    return String(content);
  }
}

export function heuristicIntent(message: string): IntentPlan {
  const text = message.trim();
  if (!text) {
    return { intent: 'clarify', confidence: 1, rewritten_query: '', needs_retrieval: false, slots: {} };
  }
  if (/忽略.*规则|系统提示词|越权|密码|token|密钥/i.test(text)) {
    return { intent: 'unsafe', confidence: 0.98, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/天气|下雨|温度|气温|预报/.test(text)) {
    return { intent: 'weather', confidence: 0.94, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/怎么走|路线|公交|驾车|步行|从.+到/.test(text)) {
    return { intent: 'route', confidence: 0.9, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/餐厅|酒店|景点|附近|哪里有|推荐.*店/.test(text)) {
    return { intent: 'poi', confidence: 0.86, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/统计|同比|环比|总量|报表|SQL|查询.*数据|按.*排序/.test(text)) {
    return { intent: 'data_query', confidence: 0.85, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/^(你好|您好|嗨|hello|hi)[！!。.]?$/i.test(text) || text.includes('你能做什么')) {
    return { intent: 'chat', confidence: 0.95, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  if (/^帮我安排.*$|^给我一个方案$/.test(text)) {
    return { intent: 'clarify', confidence: 0.72, rewritten_query: text, needs_retrieval: false, slots: {} };
  }
  return { intent: 'knowledge_qa', confidence: 0.6, rewritten_query: text, needs_retrieval: true, slots: {} };
}

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (!left.length || !right.length || left.length !== right.length) return null;
  const denom =
    Math.sqrt(left.reduce((a, v) => a + v * v, 0)) * Math.sqrt(right.reduce((a, v) => a + v * v, 0));
  if (denom === 0) return null;
  return left.reduce((a, v, i) => a + v * right[i], 0) / denom;
}

export function protectedFacts(text: string): string[] {
  const facts: string[] = [];
  for (const line of text.split(/[\n。！？]/)) {
    const trimmed = line.trim();
    if (
      trimmed &&
      (/[0-9]/.test(trimmed) ||
        /偏好|预算|必须|不要|需要|还没|待办|日期|时间|地址|人数/.test(trimmed))
    ) {
      facts.push(trimmed.slice(0, 240));
    }
  }
  return facts.slice(0, 20);
}
