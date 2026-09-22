// 项目级会话运行时，使用冻结版本检索（对齐 Python app/services/project_chat.py）。
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../config';
import type { Subject } from '../auth/subject';
import { ragService } from '../services/rag';
import { projectModelCatalog } from '../services/projectModels';
import { createSeq, projectEvent } from '../sse';
import { getPublishedProjectRuntime } from '../repositories/projects';
import {
  createProjectConversation,
  getProjectConversation,
  listProjectConversations,
  listMessages,
  deleteProjectConversation,
  recentConversationMessages,
  saveUserMessage,
  startAssistantMessage,
  finishAssistantMessage,
} from '../repositories/conversations';
import { startAgentRun, updateAgentRunTrace, finishAgentRun } from '../repositories/platform';
import { LookupError, PermissionError, ValueError, ConversationNotOwnedError } from '../errors';
import { jsonSafe } from '../utils/json';
import type { PublishedProjectRuntime } from '../repositories/projects';

function flag(runtime: PublishedProjectRuntime, name: string): boolean {
  return Boolean((runtime.featureFlags as Record<string, unknown> | null)?.[name] ?? false);
}

export class ProjectChatService {
  private checkChatAccess(runtime: PublishedProjectRuntime, subject: Subject): void {
    if (!flag(runtime, 'chatEnabled')) throw new PermissionError('当前项目未开启对话功能');
    if (subject.kind === 'client' && !flag(runtime, 'anonymousChatEnabled')) {
      throw new PermissionError('当前项目未开启匿名对话');
    }
  }

  async createConversation(publicId: string, subject: Subject, title = ''): Promise<Record<string, unknown>> {
    const runtime = await getPublishedProjectRuntime(publicId);
    if (!runtime) throw new LookupError('项目不存在');
    this.checkChatAccess(runtime, subject);
    if (!flag(runtime, 'newConversationEnabled')) throw new PermissionError('当前项目未开启新建会话');
    return jsonSafe<Record<string, unknown>>(
      await createProjectConversation(
        subject,
        String(runtime.internalProjectId),
        String(runtime.projectVersionId),
        (title || '新对话').slice(0, 160),
      ),
    );
  }

  private async conversationContext(publicId: string): Promise<PublishedProjectRuntime> {
    const runtime = await getPublishedProjectRuntime(publicId);
    if (!runtime) throw new LookupError('项目不存在');
    return runtime;
  }

  private async requireConversation(publicId: string, conversationId: string, subject: Subject) {
    const runtime = await this.conversationContext(publicId);
    const conversation = await getProjectConversation(subject, publicId, conversationId);
    if (!conversation) throw new ConversationNotOwnedError('会话不存在或不属于当前项目');
    return { runtime, conversation };
  }

  async listConversations(publicId: string, subject: Subject, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const runtime = await this.conversationContext(publicId);
    if (!flag(runtime, 'conversationHistoryEnabled')) throw new PermissionError('当前项目未开启会话历史');
    return jsonSafe<Record<string, unknown>[]>(
      await listProjectConversations(subject, String(runtime.internalProjectId), Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)),
    );
  }

  async listMessages(publicId: string, conversationId: string, subject: Subject, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const { conversation } = await this.requireConversation(publicId, conversationId, subject);
    if (!flag(conversation as PublishedProjectRuntime, 'conversationHistoryEnabled')) {
      throw new PermissionError('当前项目未开启会话历史');
    }
    return jsonSafe<Record<string, unknown>[]>(
      await listMessages(conversationId, Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)),
    );
  }

  async deleteConversation(publicId: string, conversationId: string, subject: Subject): Promise<Record<string, unknown>> {
    const { conversation } = await this.requireConversation(publicId, conversationId, subject);
    if (!flag(conversation as PublishedProjectRuntime, 'conversationHistoryEnabled')) {
      throw new PermissionError('当前项目未开启会话历史');
    }
    const internalProjectId = String((conversation as { internalProjectId?: string }).internalProjectId ?? '');
    const deleted = await deleteProjectConversation(subject, internalProjectId, conversationId);
    if (!deleted) throw new ConversationNotOwnedError('会话不存在或不属于当前项目');
    return { conversationId, deleted: true };
  }

  async validateChat(publicId: string, conversationId: string, subject: Subject, message: string): Promise<Record<string, unknown>> {
    if (!message.trim()) throw new ValueError('message 不能为空');
    const { conversation } = await this.requireConversation(publicId, conversationId, subject);
    this.checkChatAccess(conversation as PublishedProjectRuntime, subject);
    return jsonSafe<Record<string, unknown>>(conversation);
  }

  async *streamChat(
    publicId: string,
    conversationId: string,
    subject: Subject,
    message: string,
    runtime: PublishedProjectRuntime,
    requestId?: string,
  ): AsyncGenerator<string> {
    const reqId = requestId ?? crypto.randomUUID();
    const projectVersionId = String(runtime.projectVersionId);
    const threadId = `${publicId}:${projectVersionId}:${conversationId}`;
    const next = createSeq();
    let assistantMessageId: string | null = null;
    let runId: string | null = null;
    let outcome: 'completed' | 'failed' | 'interrupted' = 'failed';
    let reply = '';
    let sources: Record<string, unknown>[] = [];
    const modelUsage: Record<string, unknown>[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const emit = (eventType: string, data: Record<string, unknown>): string =>
      projectEvent(eventType, data, reqId, threadId, publicId, projectVersionId, next());

    try {
      runId = await startAgentRun({
        tenantId: String(runtime.tenantId),
        applicationId: String(runtime.internalProjectId),
        conversationId,
        threadId,
        graphName: 'project_chat',
        graphVersion: '1',
      });
      const history = await recentConversationMessages(conversationId, 12);
      await saveUserMessage(conversationId, message);
      assistantMessageId = await startAssistantMessage(conversationId);
      yield emit('status', { stage: 'accepted' });

      sources = jsonSafe<Record<string, unknown>[]>(
        await ragService.retrieveProject(message, {
          tenantId: String(runtime.tenantId),
          knowledgeBaseIds: [...(runtime.knowledgeBaseIds ?? [])],
          limit: 5,
        }),
      );
      if (flag(runtime, 'sourceReferencesEnabled') && sources.length) {
        yield emit('sources', { sources });
      }

      const sourceContext = sources
        .map((item, index) => `[来源 ${index + 1}] ${item.title ?? ''}\n${item.content ?? ''}`)
        .join('\n\n');
      let system = String(runtime.systemPrompt || '你是一个严谨的 AI 助手。');
      system += '\n只依据用户提供的资料回答；资料不足时明确说明，不得编造。';
      if (sourceContext) system += `\n\n<approved_sources>\n${sourceContext}\n</approved_sources>`;

      const messages: BaseMessage[] = [new SystemMessage(system)];
      for (const item of history) {
        const content = String((item as { content?: unknown }).content ?? '');
        if ((item as { role?: string }).role === 'assistant') messages.push(new AIMessage(content));
        else if ((item as { role?: string }).role === 'user') messages.push(new HumanMessage(content));
      }
      messages.push(new HumanMessage(message));

      const model = projectModelCatalog.buildChatModel(String(runtime.modelKey), {
        temperature: Number(runtime.temperature ?? 0.7),
        maxTokens: Number(runtime.maxTokens ?? 1600),
        streaming: true,
      });

      const collectUsage = (value: unknown): void => {
        const usage = (value as { usage_metadata?: Record<string, unknown> } | null)?.usage_metadata;
        if (!usage || typeof usage !== 'object') return;
        const current = Object.fromEntries(
          Object.entries(usage).filter(([k, v]) => ['input_tokens', 'output_tokens', 'total_tokens'].includes(k) && typeof v === 'number'),
        );
        if (!Object.keys(current).length) return;
        modelUsage.push({ role: 'answer', model: String(runtime.modelKey), ...current });
        inputTokens += Number(usage.input_tokens ?? 0);
        outputTokens += Number(usage.output_tokens ?? 0);
      };

      const streamable = model as unknown as { stream?: (m: unknown[]) => AsyncIterable<{ content?: unknown }> };
      if (typeof streamable.stream === 'function') {
        for await (const chunk of streamable.stream(messages)) {
          collectUsage(chunk);
          const content = (chunk as { content?: unknown }).content;
          if (typeof content !== 'string' || !content) continue;
          reply += content;
          yield emit('chunk', { content });
        }
      } else {
        const result = await (model as { invoke: (m: unknown[]) => Promise<{ content?: unknown }> }).invoke(messages);
        collectUsage(result);
        reply = typeof result.content === 'string' ? result.content : String(result.content ?? '');
        yield emit('chunk', { content: reply });
      }

      if (assistantMessageId) {
        await finishAssistantMessage(assistantMessageId, {
            content: reply,
            sources: flag(runtime, 'sourceReferencesEnabled') ? sources : [],
            toolCalls: [],
            status: 'complete',
          });
      }
      outcome = 'completed';
      yield emit('complete', {
        messageId: assistantMessageId,
        reply,
        sources: flag(runtime, 'sourceReferencesEnabled') ? sources : [],
      });
    } catch {
      if (assistantMessageId) {
        try {
          await finishAssistantMessage(assistantMessageId, {
              content: reply,
              sources,
              toolCalls: [],
              status: 'failed',
            });
        } catch {
          /* ignore */
        }
      }
      yield emit('error', { message: '项目 Agent 暂时不可用' });
    } finally {
      if (runId) {
        try {
          const estimatedCost =
            inputTokens || outputTokens
              ? (inputTokens / 1000) * config.modelInputCostCnyPer1k + (outputTokens / 1000) * config.modelOutputCostCnyPer1k
              : null;
          await updateAgentRunTrace(runId, {
            traceId: reqId,
            modelRoutes: [{ role: 'answer', intent: 'project_chat', model: String(runtime.modelKey) }],
            modelUsage,
            toolCallCount: 0,
            inputTokens,
            outputTokens,
            estimatedCostCny: estimatedCost,
          });
        } catch {
          /* ignore */
        }
        try {
          await finishAgentRun(runId, outcome, outcome === 'completed' ? null : 'PROJECT_AGENT_FAILED');
        } catch {
          /* ignore */
        }
      }
      yield emit('end', {});
    }
  }
}

export const projectChatService = new ProjectChatService();
