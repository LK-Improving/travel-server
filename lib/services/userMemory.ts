/**
 * 用户长短记忆（Node 版原有能力，Python 版没有对应模块，迁移时保留）。
 * 对齐旧实现 src/services/userMemoryServer.js：
 *   长期摘要（travel_user_memory_summaries）+ 短期窗口（travel_user_memories 近 N 条）。
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { config } from '../config';
import { query, queryOne, execute, toJsonObject } from '../db/pool';
import { buildChatModel } from './llm';

const DEFAULT_CONVERSATION_ID = 'default';
const MAX_CONVERSATION_ID_LENGTH = 64;
const MAX_MEMORY_CONTENT_LENGTH = 4000;
const DEFAULT_MEMORY_MESSAGE_LIMIT = 6;
const DEFAULT_MEMORY_KEEP_LIMIT = 50;
const DEFAULT_SUMMARY_THRESHOLD = 20;
const SUMMARY_INPUT_LIMIT = 50;
const MAX_SUMMARY_LENGTH = 4000;

export interface MemoryRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

interface MemoryRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: unknown;
  created_at: string | Date | null;
}

export interface MemorySummary {
  summary: string;
  coveredUntil: string | null;
  sourceMessageCount: number;
  updatedAt: string | null;
}

function normalizeConversationId(value: unknown): string {
  const text = String(value ?? DEFAULT_CONVERSATION_ID).trim();
  return (text || DEFAULT_CONVERSATION_ID).slice(0, MAX_CONVERSATION_ID_LENGTH);
}

function normalizeContent(value: unknown): string {
  return String(value ?? '').trim().slice(0, MAX_MEMORY_CONTENT_LENGTH);
}

function clampLimit(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), 1), 20);
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    id: String(row.id),
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: toJsonObject(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

export class UserMemoryService {
  async list(userId: string, conversationId: unknown, limit?: unknown): Promise<{
    conversationId: string;
    items: MemoryRecord[];
  }> {
    const safeConversationId = normalizeConversationId(conversationId);
    const safeLimit = clampLimit(limit ?? config.memoryMessageLimit, DEFAULT_MEMORY_MESSAGE_LIMIT);
    const rows = await query<MemoryRow>(
      `SELECT id,conversation_id,role,content,metadata,created_at
       FROM travel_user_memories
       WHERE user_id=$1 AND conversation_id=$2
       ORDER BY created_at DESC LIMIT $3`,
      [userId, safeConversationId, safeLimit],
    );
    // 先取最近 N 条再反转，保证交给模型的顺序是时间正序。
    return { conversationId: safeConversationId, items: rows.reverse().map(toMemory) };
  }

  private async recentMessages(userId: string, conversationId: string, limit?: unknown): Promise<BaseMessage[]> {
    const safeLimit = clampLimit(limit ?? config.memoryMessageLimit, DEFAULT_MEMORY_MESSAGE_LIMIT);
    const rows = await query<{ role: string; content: string }>(
      `SELECT role,content FROM travel_user_memories
       WHERE user_id=$1 AND conversation_id=$2
       ORDER BY created_at DESC LIMIT $3`,
      [userId, conversationId, safeLimit],
    );
    return rows
      .reverse()
      .map((row) =>
        row.role === 'assistant' ? new AIMessage(row.content) : new HumanMessage(row.content),
      );
  }

  async getSummary(userId: string, conversationId: unknown): Promise<MemorySummary | null> {
    const safeConversationId = normalizeConversationId(conversationId);
    const row = await queryOne<{
      summary: string;
      covered_until: string | Date | null;
      source_message_count: number | null;
      updated_at: string | Date | null;
    }>(
      `SELECT summary,covered_until,source_message_count,updated_at
       FROM travel_user_memory_summaries
       WHERE user_id=$1 AND conversation_id=$2`,
      [userId, safeConversationId],
    );
    if (!row) return null;
    return {
      summary: String(row.summary ?? ''),
      coveredUntil: toIso(row.covered_until),
      sourceMessageCount: Number(row.source_message_count ?? 0),
      updatedAt: toIso(row.updated_at),
    };
  }

  /** 【长期摘要 SystemMessage】+【近 N 条原文】，等价于 LangChain 的 summary buffer memory。 */
  async getMemoryContext(userId: string, conversationId: unknown, limit?: unknown): Promise<BaseMessage[]> {
    const safeConversationId = normalizeConversationId(conversationId);
    const [summary, recent] = await Promise.all([
      this.getSummary(userId, safeConversationId),
      this.recentMessages(userId, safeConversationId, limit),
    ]);
    const messages: BaseMessage[] = [];
    if (summary?.summary) {
      messages.push(
        new SystemMessage(`以下是此前对话的事实摘要（仅供参考，不要向用户复述）：\n${summary.summary}`),
      );
    }
    messages.push(...recent);
    return messages;
  }

  /**
   * 增量摘要：新增消息超过阈值时，把「旧摘要 + 新增消息」压缩成新摘要。
   * 设计为回答落盘后 best-effort 调用，失败不影响主链路。
   */
  async maybeSummarize(userId: string, conversationId: unknown): Promise<{
    summarized: boolean;
    reason?: string;
    pendingCount?: number;
    coveredCount?: number;
  }> {
    const safeConversationId = normalizeConversationId(conversationId);
    const threshold = Math.max(config.memorySummaryThreshold, 4);

    const summaryRow = await this.getSummary(userId, safeConversationId);
    const coveredUntil = summaryRow?.coveredUntil ?? new Date(0).toISOString();

    const pending = await query<{ role: string; content: string; created_at: string | Date }>(
      `SELECT role,content,created_at FROM travel_user_memories
       WHERE user_id=$1 AND conversation_id=$2 AND created_at > $3
       ORDER BY created_at ASC LIMIT $4`,
      [userId, safeConversationId, coveredUntil, SUMMARY_INPUT_LIMIT],
    );

    if (pending.length < threshold) {
      return { summarized: false, reason: 'BELOW_THRESHOLD', pendingCount: pending.length };
    }

    const transcript = pending
      .map((row) => `${row.role === 'assistant' ? '助手' : '用户'}：${row.content}`)
      .join('\n');

    const response = await buildChatModel().invoke([
      new SystemMessage(
        '你是对话记忆压缩器。请将旅游对话压缩为简短事实摘要，只保留用户偏好、已确认约束和未解决问题，不添加原文之外的新事实，不输出寒暄。',
      ),
      new HumanMessage(
        `既有摘要：\n${summaryRow?.summary || '（无）'}\n\n新增对话：\n${transcript}\n\n请输出合并后的新摘要。`,
      ),
    ]);

    const summary = String(response.content ?? '').trim().slice(0, MAX_SUMMARY_LENGTH);
    if (!summary) return { summarized: false, reason: 'EMPTY_SUMMARY' };

    const lastCreatedAt = pending[pending.length - 1].created_at;
    await execute(
      `INSERT INTO travel_user_memory_summaries
         (user_id,conversation_id,summary,covered_until,source_message_count,updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (user_id,conversation_id)
       DO UPDATE SET summary=EXCLUDED.summary,
                     covered_until=EXCLUDED.covered_until,
                     source_message_count=travel_user_memory_summaries.source_message_count + EXCLUDED.source_message_count,
                     updated_at=NOW()`,
      [userId, safeConversationId, summary, toIso(lastCreatedAt), pending.length],
    );

    return { summarized: true, coveredCount: pending.length };
  }

  /** 把一轮问答落库，并裁剪到保留条数上限。 */
  async rememberExchange(options: {
    userId: string;
    conversationId?: unknown;
    userMessage: string;
    assistantMessage: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; reason?: string; conversationId: string }> {
    const safeConversationId = normalizeConversationId(options.conversationId);
    const safeUserMessage = normalizeContent(options.userMessage);
    const safeAssistantMessage = normalizeContent(options.assistantMessage);
    if (!safeUserMessage || !safeAssistantMessage) {
      return { success: false, reason: 'EMPTY_MEMORY_CONTENT', conversationId: safeConversationId };
    }

    const metadata = JSON.stringify(toJsonObject(options.metadata ?? {}));
    await execute(
      `INSERT INTO travel_user_memories (user_id,conversation_id,role,content,metadata)
       VALUES ($1,$2,'user',$3,$5::jsonb), ($1,$2,'assistant',$4,$5::jsonb)`,
      [options.userId, safeConversationId, safeUserMessage, safeAssistantMessage, metadata],
    );
    await this.prune(options.userId, safeConversationId);
    return { success: true, conversationId: safeConversationId };
  }

  async prune(userId: string, conversationId: string): Promise<void> {
    const keepLimit = Math.max(Math.floor(config.memoryKeepLimit), 10);
    await execute(
      `DELETE FROM travel_user_memories
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS row_num
           FROM travel_user_memories
           WHERE user_id=$1 AND conversation_id=$2
         ) ranked
         WHERE ranked.row_num > $3
       )`,
      [userId, conversationId, keepLimit],
    );
  }

  async clear(userId: string, conversationId: unknown): Promise<{ conversationId: string }> {
    const safeConversationId = normalizeConversationId(conversationId);
    await execute('DELETE FROM travel_user_memories WHERE user_id=$1 AND conversation_id=$2', [
      userId,
      safeConversationId,
    ]);
    await execute(
      'DELETE FROM travel_user_memory_summaries WHERE user_id=$1 AND conversation_id=$2',
      [userId, safeConversationId],
    );
    return { conversationId: safeConversationId };
  }
}

export const userMemoryService = new UserMemoryService();
