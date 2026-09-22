// 标准 LangGraph 工具调用 RAG 循环：agent -> ToolNode -> sources -> agent。
// 对齐 Python app/rag_base/agent_graph.py。
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { Annotation, StateGraph, START, END, MessagesAnnotation, addMessages, type CompiledStateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import Decimal from 'decimal.js';
import { parseBudgetBlock } from '../skills/budget';
import { ContextManager, type EmbedFn, type SummarizeFn, type JudgeFn } from './context_manager';
import { heuristicIntent, messageText, type IntentPlan } from './types';
import type { ModelRouter } from '../services/modelRouter';

export interface RagAgentState {
  messages: BaseMessage[];
  sources: unknown[];
  budget_cny: Decimal | null;
  budget_replan_count: number;
  budget_feedback: string | null;
  intent_plan: Record<string, unknown>;
  memory_summary: string;
  memory_summary_embedding: number[] | null;
  memory_embedding_model: string | null;
  context_messages: BaseMessage[];
  prune_action: string;
  prune_similarity: number | null;
  model_routes: Record<string, unknown>[];
}

const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  sources: Annotation<unknown[]>({ reducer: (_x, y) => y ?? [], default: () => [] }),
  budget_cny: Annotation<Decimal | null>({ reducer: (_x, y) => y, default: () => null }),
  budget_replan_count: Annotation<number>({ reducer: (_x, y) => y ?? 0, default: () => 0 }),
  budget_feedback: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
  intent_plan: Annotation<Record<string, unknown>>({ reducer: (_x, y) => y ?? {}, default: () => ({}) }),
  memory_summary: Annotation<string>({ reducer: (_x, y) => y ?? '', default: () => '' }),
  memory_summary_embedding: Annotation<number[] | null>({ reducer: (_x, y) => y, default: () => null }),
  memory_embedding_model: Annotation<string | null>({ reducer: (_x, y) => y, default: () => null }),
  context_messages: Annotation<BaseMessage[]>({ reducer: (_x, y) => y ?? [], default: () => [] }),
  prune_action: Annotation<string>({ reducer: (_x, y) => y ?? '', default: () => '' }),
  prune_similarity: Annotation<number | null>({ reducer: (_x, y) => y, default: () => null }),
  model_routes: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => (a ?? []).concat(b ?? []),
    default: () => [],
  }),
});

type StateType = typeof StateAnnotation.State;

const SYSTEM_PROMPT =
  '你是严谨的旅游 RAG 助手。询问有哪些知识库、知识库数量或文档数量时调用 list_knowledge_bases；' +
  '涉及知识库正文事实时调用 search_knowledge_base。实时天气、POI、路线只能来自对应工具。' +
  '只依据工具结果回答，资料不足时明确说明，不得编造。';

const BUDGET_PROMPT = (budgetCny: string) =>
  `用户给出了 ${budgetCny} 元人民币预算。最终答复必须在正文后恰好附加一个费用块，格式严格如下：` +
  `<budget_plan>{"items":[{"name":"费用名称","unitPriceCny":0,"quantity":1}]}</budget_plan>` +
  '费用块内部只能是 JSON；每项只能包含 name、unitPriceCny、quantity，单价只能依据本轮工具结果，禁止编造价格。' +
  '如果工具结果不足以形成费用明细，请明确说明资料不足，但仍不得虚构费用。';

const INVALID_FINAL_FEEDBACK =
  '预算校验未通过：模型未返回可校验的最终答复。请在不编造价格的前提下重新规划并输出费用明细。';
const FALLBACK_PROMPT =
  '预算方案已经连续两次未通过确定性校验。你现在生成最终兜底答复：' +
  '不得调用工具，不得声称方案已经满足预算，也不得编造或承诺任何价格；' +
  '请清楚说明当前无法确认预算内方案，并仅基于已有对话和工具结果给出透明、保守的参考建议。' +
  '不要输出 <budget_plan> 费用块。';
const MAX_BUDGET_REPLANS = 2;

function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return messageText(messages[i]);
  }
  return '';
}

function usageOf(response: unknown): Record<string, unknown> {
  const r = response as { usage_metadata?: Record<string, unknown>; response_metadata?: Record<string, unknown> };
  return (r.usage_metadata ?? r.response_metadata?.tokenUsage ?? {}) as Record<string, unknown>;
}

export interface BuildRagAgentGraphOptions {
  model: BaseChatModel;
  tools: DynamicStructuredTool[];
  checkpointer?: unknown | null;
  intentClassifier?: { classify: (text: string) => Promise<IntentPlan | Record<string, unknown>> } | null;
  contextManager?: ContextManager | null;
  modelRouter?: ModelRouter | null;
  embedFn?: EmbedFn | null;
  summarizer?: SummarizeFn | null;
  judge?: JudgeFn | null;
}

/**
 * 返回类型交给推断：CompiledStateGraph 有 10 个泛型参数且带约束，
 * 手写一遍既冗长又会在 langgraph 升级时碎掉，用推断更稳。
 */
export function buildRagAgentGraph(opts: BuildRagAgentGraphOptions) {
  const { model, tools, checkpointer = null } = opts;
  const contextManager = opts.contextManager ?? new ContextManager({ embeddingService: opts.embedFn ?? null, summarizer: opts.summarizer ?? null, judge: opts.judge ?? null });
  // bindTools 在 BaseChatModel 上是可选方法，编译期收窄后再绑定。
  const bindTools = (target: typeof model): typeof model =>
    typeof target.bindTools === 'function' ? (target.bindTools(tools as never[]) as typeof model) : target;
  const plannerToolModel = bindTools(model);
  const answerToolModel = bindTools(model);

  async function classifyIntent(state: StateType): Promise<Partial<StateType>> {
    const current = lastHumanText(state.messages);
    let plan: IntentPlan;
    if (!opts.intentClassifier) {
      plan = heuristicIntent(current);
    } else {
      const raw = await opts.intentClassifier.classify(current);
      plan = raw as unknown as IntentPlan;
    }
    return { intent_plan: plan as unknown as Record<string, unknown> };
  }

  async function prepareContext(state: StateType): Promise<Partial<StateType>> {
    const summary = String(state.memory_summary ?? '');
    return { context_messages: contextManager.modelMessages(summary, state.messages) };
  }

  async function compactContext(state: StateType): Promise<Partial<StateType>> {
    const result = await contextManager.compact({ summary: String(state.memory_summary ?? ''), messages: state.messages });
    const patch: Partial<StateType> = {
      memory_summary: result.memory_summary,
      memory_summary_embedding: result.memory_summary_embedding,
      prune_action: result.prune_action,
      prune_similarity: result.prune_similarity,
    } as Partial<StateType>;
    const oldMessages = state.messages;
    if (oldMessages.length > contextManager.keepMessages) {
      patch.messages = oldMessages
        .slice(0, -contextManager.keepMessages)
        .filter((m) => m.id)
        .map((m) => new RemoveMessage({ id: m.id as string }));
    }
    return patch;
  }

  async function agent(state: StateType): Promise<Partial<StateType>> {
    let systemPrompt = SYSTEM_PROMPT;
    const plan = (state.intent_plan ?? {}) as unknown as IntentPlan;
    if (plan && plan.intent) {
      systemPrompt +=
        '\n本轮结构化意图：' + JSON.stringify(plan) + '。遵守该意图进行分流；chat、clarify、unsafe 不得调用任何工具。';
    }
    const budgetCny = state.budget_cny;
    if (budgetCny != null) {
      systemPrompt += BUDGET_PROMPT(budgetCny.toString());
    }
    const lastMessage = state.messages[state.messages.length - 1];
    const afterTool = lastMessage instanceof ToolMessage;
    let decision: Record<string, unknown>;
    if (opts.modelRouter) {
      decision = opts.modelRouter.decide(plan as unknown as Record<string, unknown>, { afterTool }) as unknown as Record<string, unknown>;
    } else {
      decision = {
        role: afterTool ? 'answer' : 'planner',
        intent: plan.intent,
        model: 'provider_default',
        reason: '兼容模式',
      };
    }
    const activeModel = decision.role === 'answer' ? answerToolModel : plannerToolModel;
    const response = await activeModel.invoke([new SystemMessage(systemPrompt), ...(state.context_messages ?? state.messages)]);
    return { messages: [response], model_routes: [{ ...decision, usage: usageOf(response) }] };
  }

  async function validateBudget(state: StateType): Promise<Partial<StateType>> {
    const budgetCny = state.budget_cny;
    if (budgetCny == null) return { budget_feedback: null };
    const lastMessage = state.messages[state.messages.length - 1];
    if (!(lastMessage instanceof AIMessage) || (lastMessage as AIMessage).tool_calls?.length) {
      return {
        messages: [new HumanMessage(INVALID_FINAL_FEEDBACK)],
        budget_feedback: INVALID_FINAL_FEEDBACK,
        budget_replan_count: Math.min((state.budget_replan_count ?? 0) + 1, MAX_BUDGET_REPLANS),
      };
    }
    const content = typeof lastMessage.content === 'string' ? lastMessage.content : '';
    const validation = parseBudgetBlock(content, budgetCny);
    if (validation.valid) {
      return {
        messages: [new AIMessage({ content: validation.answer, tool_calls: [] })],
        budget_feedback: null,
        budget_replan_count: state.budget_replan_count ?? 0,
      };
    }
    const feedback = validation.feedback ?? INVALID_FINAL_FEEDBACK;
    return {
      messages: [new HumanMessage(feedback)],
      budget_feedback: feedback,
      budget_replan_count: Math.min((state.budget_replan_count ?? 0) + 1, MAX_BUDGET_REPLANS),
    };
  }

  async function fallbackFinal(state: StateType): Promise<Partial<StateType>> {
    const response = await answerToolModel.invoke([new SystemMessage(FALLBACK_PROMPT), ...state.messages]);
    const content = response instanceof AIMessage && typeof response.content === 'string' ? response.content : '';
    const answer = parseBudgetBlock(content, state.budget_cny ?? Decimal(0)).answer || '预算方案已达到重规划上限，目前无法确认满足预算的可行方案。';
    return {
      messages: [new AIMessage(answer)],
      model_routes: [
        {
          role: 'answer',
          intent: 'budget_fallback',
          model: 'provider_default',
          reason: '预算校验兜底',
          usage: usageOf(response),
        },
      ],
    };
  }

  function routeAgentResult(state: StateType): 'tools' | 'validate_budget' | 'compact_context' {
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage instanceof AIMessage && (lastMessage as AIMessage).tool_calls?.length) return 'tools';
    if (state.budget_cny != null) return 'validate_budget';
    return 'compact_context';
  }

  function routeBudgetResult(state: StateType): 'agent' | 'fallback_final' | 'compact_context' {
    if (state.budget_feedback == null) return 'compact_context';
    if ((state.budget_replan_count ?? 0) >= MAX_BUDGET_REPLANS) return 'fallback_final';
    return 'agent';
  }

  const graph = new StateGraph(StateAnnotation)
    .addNode('classify_intent', classifyIntent)
    .addNode('prepare_context', prepareContext)
    .addNode('agent', agent)
    .addNode('tools', new ToolNode(tools as never[], { handleToolErrors: true }))
    .addNode('capture_sources', (state: StateType) => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i];
        if (message instanceof ToolMessage && message.name === 'search_knowledge_base') {
          try {
            const payload = JSON.parse(String(message.content));
            return { sources: Array.isArray(payload) ? payload : [] };
          } catch {
            return { sources: [] };
          }
        }
      }
      return { sources: [] };
    })
    .addNode('validate_budget', validateBudget)
    .addNode('fallback_final', fallbackFinal)
    .addNode('compact_context', compactContext);

  graph.addEdge(START, 'classify_intent');
  graph.addEdge('classify_intent', 'prepare_context');
  graph.addEdge('prepare_context', 'agent');
  graph.addConditionalEdges('agent', routeAgentResult, {
    tools: 'tools',
    validate_budget: 'validate_budget',
    compact_context: 'compact_context',
  });
  graph.addEdge('tools', 'capture_sources');
  graph.addEdge('capture_sources', 'prepare_context');
  graph.addConditionalEdges('validate_budget', routeBudgetResult, {
    agent: 'prepare_context',
    fallback_final: 'fallback_final',
    compact_context: 'compact_context',
  });
  graph.addEdge('compact_context', END);

  return graph.compile({ checkpointer: checkpointer as never });
}
