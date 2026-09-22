// 平台 Agent 运行器：租户作用域、策略守卫工具、SSE 流式。
// 对齐 Python app/routers/platform_agent.py（事件名与字段保持一致）。
import { HumanMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { buildRagAgentGraph } from '../rag_base/agent_graph';
import { createRagTools } from '../rag_base/tools';
import { ContextManager } from '../rag_base/context_manager';
import { getCheckpointer } from '../infra/checkpointer';
import { llmService } from './llm';
import { modelRouter } from './modelRouter';
import { ragService } from './rag';
import { platformEvent, createSeq } from '../sse';
import { config } from '../config';
import { PlatformToolRegistry, type ToolExecutionContext } from './tool_policy';
import { startAgentRun, updateAgentRunTrace, finishAgentRun } from '../repositories/platform';

function createTenantRetriever(tenantId: string, knowledgeBaseIds: string[]) {
  return {
    retrieve: (query: string, opts: { limit?: number }) =>
      ragService.retrieveProject(query, {
        tenantId,
        knowledgeBaseIds,
        limit: opts.limit ?? 5,
      }),
  } as typeof ragService;
}

function guardedTools(
  tools: DynamicStructuredTool[],
  registry: PlatformToolRegistry,
  context: ToolExecutionContext,
): DynamicStructuredTool[] {
  return tools.map(
    (tool) =>
      new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
        func: async (args: Record<string, unknown>) => registry.execute(tool.name, args, context),
      }),
  );
}

export interface RunPlatformChatOptions {
  message: string;
  conversationId: string;
  context: ToolExecutionContext;
  knowledgeBaseIds: string[];
}

export async function* runPlatformChat(options: RunPlatformChatOptions): AsyncGenerator<string> {
  const { context, knowledgeBaseIds, conversationId, message } = options;
  const next = createSeq();
  const requestId = String(context.traceId ?? crypto.randomUUID());
  const threadId = `${context.tenantId}:${context.applicationId}:${conversationId}`;
  let runId: string | null = null;
  let outcome: 'completed' | 'failed' | 'interrupted' = 'failed';
  let reply = '';
  const toolCalls: Record<string, unknown>[] = [];
  const modelUsage: Record<string, unknown>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let intent: string | null = null;
  const skillVersions: Record<string, string>[] = [];

  const emit = (eventType: string, data: Record<string, unknown>): string =>
    platformEvent(eventType, data, requestId, threadId, next());

  try {
    runId = await startAgentRun({
      tenantId: context.tenantId,
      applicationId: context.applicationId,
      conversationId,
      threadId,
      graphName: 'platform_agent',
      graphVersion: '1',
    });
    yield emit('status', { stage: 'accepted', traceId: requestId });

    const checkpointer = await getCheckpointer();
    const model = llmService.buildChatModel();
    const rawTools = createRagTools({ retriever: createTenantRetriever(context.tenantId, knowledgeBaseIds) });
    const registry = new PlatformToolRegistry(rawTools);
    const tools = guardedTools(rawTools, registry, context);
    const embedFn = async (texts: string[]) => llmService.embedDocuments(texts);
    const contextManager = new ContextManager({ embeddingService: embedFn });
    const graph = buildRagAgentGraph({ model, tools, checkpointer, contextManager, modelRouter });

    const stream = await graph.streamEvents(
      { messages: [new HumanMessage(message)] },
      { version: 'v2', configurable: { thread_id: threadId } },
    );

    for await (const event of stream) {
      if (event.event === 'on_chat_model_stream') {
        const chunk = (event.data as { chunk?: { content?: unknown } } | undefined)?.chunk;
        const content = typeof chunk?.content === 'string' ? chunk.content : '';
        if (content) {
          reply += content;
          yield emit('chunk', { content });
        }
      } else if (event.event === 'on_tool_end') {
        const name = String((event as { name?: string }).name ?? 'tool');
        const output = (event.data as { output?: unknown } | undefined)?.output;
        toolCalls.push({ name });
        if (typeof output === 'string' && output.includes('审批编号：')) {
          const approvalId = output.split('审批编号：', 1)[1]?.trim() ?? '';
          yield emit('approval_required', { approvalId, toolName: name });
        } else {
          yield emit('tool_result', { name, output });
        }
      }
    }

    const state = await graph.getState({ configurable: { thread_id: threadId } });
    const values = (state as { values?: Record<string, unknown> }).values ?? {};
    intent = (values.intent as string) ?? null;
    const messages = (values.messages as { content?: unknown; type?: string; tool_calls?: unknown[] }[]) ?? [];
    const lastAi = [...messages].reverse().find((m) => m.type === 'ai');
    if (lastAi && typeof lastAi.content === 'string' && lastAi.content.trim()) {
      reply = lastAi.content;
    }
    for (const call of toolCalls) {
      const skill = String(call.name ?? '');
      if (skill && !skillVersions.some((item) => item.name === skill)) {
        skillVersions.push({ name: skill, version: '1.0.0' });
      }
    }
    const estimatedCostCny =
      inputTokens || outputTokens
        ? Math.round((inputTokens / 1000) * config.modelInputCostCnyPer1k +
            (outputTokens / 1000) * config.modelOutputCostCnyPer1k) * 1e-6
        : null;
    outcome = 'completed';
    yield emit('complete', {
      success: true,
      reply,
      toolCalls,
      intent,
      traceId: requestId,
      modelUsage,
      skillVersions,
      estimatedCostCny,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Platform Agent 暂时不可用';
    yield emit('error', { message: messageText });
  } finally {
    if (runId) {
      try {
        await updateAgentRunTrace(runId, {
          traceId: requestId,
          intent,
          modelUsage,
          skillVersions,
          toolCallCount: toolCalls.length,
          inputTokens,
          outputTokens,
          estimatedCostCny: null,
        });
      } catch {
        /* 跟踪写入失败不影响响应 */
      }
      try {
        await finishAgentRun(
          runId,
          outcome,
          outcome === 'completed' ? null : 'PLATFORM_AGENT_FAILED',
        );
      } catch {
        /* 同上 */
      }
    }
    yield emit('end', {});
  }
}
