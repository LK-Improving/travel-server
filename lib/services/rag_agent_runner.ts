// RAG Agent 运行器：构造 LangGraph 图并转为 SSE 事件流（对齐 Python app/routers/rag_agent.py）。
import Decimal from 'decimal.js';
import { HumanMessage } from '@langchain/core/messages';

import { buildRagAgentGraph } from '../rag_base/agent_graph';
import { createRagTools } from '../rag_base/tools';
import { ContextManager } from '../rag_base/context_manager';
import { getCheckpointer } from '../infra/checkpointer';
import { llmService } from './llm';
import { modelRouter } from './modelRouter';
import { agentEvent, createSeq } from '../sse';

/** 图类型随 buildRagAgentGraph 的实现变化，用推断别名避免手写 10 个泛型参数。 */
type RagAgentGraph = Awaited<ReturnType<typeof buildRagAgentGraph>>;

let graphPromise: Promise<RagAgentGraph> | null = null;

async function getGraph(): Promise<RagAgentGraph> {
  if (!graphPromise) {
    graphPromise = (async () => {
      const checkpointer = await getCheckpointer();
      const model = llmService.buildChatModel();
      const tools = createRagTools();
      const embedFn = async (texts: string[]) => llmService.embedDocuments(texts);
      const contextManager = new ContextManager({ embeddingService: embedFn });
      return buildRagAgentGraph({ model, tools, checkpointer, contextManager, modelRouter });
    })();
  }
  return graphPromise;
}

export interface RunRagChatOptions {
  message: string;
  threadId: string;
  conversationId?: string | null;
  budgetCny?: string | number | Decimal | null;
}

export async function* runRagChat(options: RunRagChatOptions): AsyncGenerator<string> {
  const graph = await getGraph();
  const next = createSeq();
  const requestId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  let finalAnswer = '';
  let sources: unknown[] = [];

  yield agentEvent('connected', { type: 'connected' }, requestId, messageId, next());
  yield agentEvent('status', { stage: 'accepted' }, requestId, messageId, next());

  const input: Record<string, unknown> = { messages: [new HumanMessage(options.message)] };
  if (options.budgetCny != null) {
    input.budget_cny = options.budgetCny instanceof Decimal ? options.budgetCny : new Decimal(String(options.budgetCny));
  }

  try {
    const stream = await graph.streamEvents(input, {
      version: 'v2',
      configurable: { thread_id: options.threadId },
    });
    for await (const event of stream) {
      if (event.event === 'on_chat_model_stream') {
        const chunk = (event.data as { chunk?: { content?: unknown } } | undefined)?.chunk;
        const content = typeof chunk?.content === 'string' ? chunk.content : '';
        if (content) {
          finalAnswer += content;
          yield agentEvent('chunk', { content }, requestId, messageId, next());
        }
      } else if (event.event === 'on_tool_end') {
        const name = String((event as { name?: string }).name ?? 'tool');
        const output = (event.data as { output?: unknown } | undefined)?.output;
        yield agentEvent('tool_result', { tool: name, output }, requestId, messageId, next());
      }
    }

    const state = await graph.getState({ configurable: { thread_id: options.threadId } });
    const values = (state as { values?: Record<string, unknown> }).values ?? {};
    sources = (values.sources as unknown[]) ?? [];
    const messages = (values.messages as { content?: unknown; type?: string }[]) ?? [];
    const lastAi = [...messages].reverse().find((m) => m.type === 'ai');
    if (lastAi && typeof lastAi.content === 'string' && lastAi.content.trim()) {
      finalAnswer = lastAi.content;
    }
    if (sources.length) yield agentEvent('sources', { sources }, requestId, messageId, next());
    yield agentEvent('complete', { messageId, reply: finalAnswer, sources }, requestId, messageId, next());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RAG Agent 暂时不可用';
    yield agentEvent('error', { message }, requestId, messageId, next());
  } finally {
    yield agentEvent('end', {}, requestId, messageId, next());
  }
}
