/**
 * 旅游规划（Node 版原有能力，Python 版没有对应模块，迁移时保留）。
 * 对齐旧实现 src/services/travelServer.js：
 *   - recommend(city, budget, days)：生成结构化 JSON 行程
 *   - chat(message, options)：SSE 流式对话，可选注入用户长短记忆并落盘
 * 模型统一走 lib/services/llm.buildChatModel，与全站 RAG/Agent 共用供应商配置。
 */
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { buildChatModel } from './llm';
import { userMemoryService } from './userMemory';
import { plainEvent } from '../sse';

const MIN_BUDGET = 100;
const MIN_DAYS = 1;
const MAX_DAYS = 10;
const DEFAULT_CONVERSATION_ID = 'default';
const MAX_CONVERSATION_ID_LENGTH = 64;

export interface TravelRecommendResult {
  success: boolean;
  content?: unknown;
  usage?: unknown;
  error?: string;
  rawResponse?: string;
}

export interface TravelChatOptions {
  userId?: string;
  conversationId?: string;
}

export interface TravelChatResult {
  success: boolean;
  reply?: string;
  memory?: { enabled: boolean; conversationId: string };
  error?: string;
}

function normalizeConversationId(value: unknown): string {
  const text = String(value ?? DEFAULT_CONVERSATION_ID).trim();
  return (text || DEFAULT_CONVERSATION_ID).slice(0, MAX_CONVERSATION_ID_LENGTH);
}

/** 从模型输出中尽力抽取 JSON：优先 ```json 围栏，退化为裸 {} 匹配。 */
function extractJson(fullResponse: string): { ok: true; data: unknown } | { ok: false; raw: string } {
  const match =
    fullResponse.match(/```json\n([\s\S]*?)\n```/) ||
    fullResponse.match(/```\n([\s\S]*?)\n```/) ||
    fullResponse.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, raw: fullResponse };
  try {
    return { ok: true, data: JSON.parse(match[0]) };
  } catch {
    return { ok: false, raw: fullResponse };
  }
}

export class TravelService {
  private buildModel() {
    return buildChatModel(undefined, undefined, {
      temperature: 0.7,
      maxTokens: undefined,
    });
  }

  async recommend(city: string, budget: number, days: number): Promise<TravelRecommendResult> {
    if (budget < MIN_BUDGET || days < MIN_DAYS || days > MAX_DAYS) {
      return { success: false, error: '预算必须在100元以上，天数必须在1天以上10天以下' };
    }
    const prompt = this.buildRecommendPrompt(city, budget, days);
    try {
      const response = await this.buildModel().invoke([prompt]);
      const fullResponse = String(response.content ?? '');
      const parsed = extractJson(fullResponse);
      if (!parsed.ok) {
        return { success: false, error: '模型输出的JSON格式错误', rawResponse: parsed.raw };
      }
      return {
        success: true,
        content: parsed.data,
        usage: (response as { usage_metadata?: unknown }).usage_metadata,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '推荐失败' };
    }
  }

  /**
   * 流式对话。返回异步生成器，每次产出一条 SSE 帧字符串（plainEvent）。
   * 主链路只负责产出 chunk/complete；异常交由 sseResponse 统一收敛为 error+end。
   */
  async *streamChat(message: string, options: TravelChatOptions): AsyncGenerator<string> {
    const memoryEnabled = Boolean(options.userId);
    const conversationId = normalizeConversationId(options.conversationId);
    const messages: BaseMessage[] = [
      new SystemMessage('你是一个专业的旅游规划师，擅长根据用户的需求生成详细的旅行行程。'),
    ];

    if (memoryEnabled && options.userId) {
      try {
        const memoryMessages = await userMemoryService.getMemoryContext(options.userId, conversationId);
        messages.push(...memoryMessages);
      } catch (error) {
        console.warn('Load user memory failed:', error);
      }
    }

    messages.push(new HumanMessage(message));

    let fullResponse = '';
    const stream = await this.buildModel().stream(messages);
    for await (const chunk of stream) {
      const content = String(chunk.content ?? '');
      if (content.trim() === '') continue;
      fullResponse += content;
      yield plainEvent({ type: 'chunk', content });
    }

    if (memoryEnabled && options.userId) {
      try {
        await userMemoryService.rememberExchange({
          userId: options.userId,
          conversationId,
          userMessage: message,
          assistantMessage: fullResponse,
          metadata: { source: 'travel_chat' },
        });
      } catch (error) {
        console.warn('Save user memory failed:', error);
      }
      userMemoryService
        .maybeSummarize(options.userId, conversationId)
        .catch((error) => console.warn('Summarize user memory failed:', error));
    }

    const result: TravelChatResult = {
      success: true,
      reply: fullResponse,
      memory: { enabled: memoryEnabled, conversationId },
    };
    yield plainEvent({ type: 'complete', data: result });
  }

  private buildRecommendPrompt(city: string, budget: number, days: number): HumanMessage {
    return new HumanMessage(
      `你是一个专业的旅游规划师，擅长根据用户的需求生成详细的旅行行程。
请根据以下信息为用户生成一份详细的旅游规划：
- 目的地城市：${city}
- 预算：${budget}元
- 旅行天数：${days}天

要求：
1. 每天的行程安排（上午、下午、晚上）
2. 每个景点的详细介绍
3. 交通建议
4. 预算分配明细
5. 注意事项

请以JSON格式输出，结构如下：
{
  "success": true,
  "city": "城市名",
  "days": 天数,
  "totalBudget": 总预算,
  "dailyItinerary": [
    {
      "day": 1,
      "date": "第1天",
      "morning": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "afternoon": {
        "spot": "景点名称",
        "duration": "游览时长",
        "ticket": "门票价格",
        "transportation": "交通方式",
        "description": "景点介绍"
      },
      "evening": {
        "spot": "活动名称",
        "duration": "活动时长",
        "ticket": "费用",
        "transportation": "交通方式",
        "description": "活动介绍"
      }
    }
  ],
  "budgetBreakdown": {
    "accommodation": 住宿费用,
    "food": 餐饮费用,
    "transportation": 交通费用,
    "tickets": 门票费用,
    "other": 其他费用
  },
  "tips": ["提示1", "提示2", "提示3"],
  "warnings": ["注意事项1", "注意事项2"]
}
  确保 JSON 格式正确，可以被解析。`,
    );
  }
}

export const travelService = new TravelService();
