import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { query } from './postgresClient.js';

const DEFAULT_CONVERSATION_ID = 'default';
const MAX_CONVERSATION_ID_LENGTH = 64;
const MAX_MEMORY_CONTENT_LENGTH = 4000;
const DEFAULT_MEMORY_MESSAGE_LIMIT = 6;
const DEFAULT_MEMORY_KEEP_LIMIT = 50;

function normalizeConversationId(conversationId) {
  const value = String(conversationId || DEFAULT_CONVERSATION_ID).trim();
  return (value || DEFAULT_CONVERSATION_ID).slice(0, MAX_CONVERSATION_ID_LENGTH);
}

function normalizeContent(content) {
  return String(content || '').trim().slice(0, MAX_MEMORY_CONTENT_LENGTH);
}

function normalizeLimit(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), 1), 20);
}

function normalizeKeepLimit(value) {
  const number = Number(value ?? DEFAULT_MEMORY_KEEP_LIMIT);
  if (!Number.isFinite(number)) return DEFAULT_MEMORY_KEEP_LIMIT;
  return Math.max(Math.floor(number), 10);
}

function toLangChainMessage(row) {
  if (row.role === 'assistant') return new AIMessage(row.content);
  if (row.role === 'system') return new SystemMessage(row.content);
  return new HumanMessage(row.content);
}

function toMemory(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

class UserMemoryServer {
  async list(userId, conversationId, options = {}) {
    const safeConversationId = normalizeConversationId(conversationId);
    const limit = normalizeLimit(options.limit || process.env.MEMORY_MESSAGE_LIMIT, DEFAULT_MEMORY_MESSAGE_LIMIT);

    const result = await query(
      `SELECT id, conversation_id, role, content, metadata, created_at
       FROM travel_user_memories
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, safeConversationId, limit],
    );

    return {
      success: true,
      conversationId: safeConversationId,
      data: result.rows.reverse().map(toMemory),
    };
  }

  async getRecentMessages(userId, conversationId, options = {}) {
    const safeConversationId = normalizeConversationId(conversationId);
    const limit = normalizeLimit(options.limit || process.env.MEMORY_MESSAGE_LIMIT, DEFAULT_MEMORY_MESSAGE_LIMIT);

    const result = await query(
      `SELECT role, content, created_at
       FROM travel_user_memories
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, safeConversationId, limit],
    );

    return result.rows.reverse().map(toLangChainMessage);
  }

  async rememberExchange({ userId, conversationId, userMessage, assistantMessage, metadata = {} }) {
    const safeConversationId = normalizeConversationId(conversationId);
    const safeUserMessage = normalizeContent(userMessage);
    const safeAssistantMessage = normalizeContent(assistantMessage);

    if (!safeUserMessage || !safeAssistantMessage) {
      return { success: false, reason: 'EMPTY_MEMORY_CONTENT' };
    }

    await query(
      `INSERT INTO travel_user_memories (user_id, conversation_id, role, content, metadata)
       VALUES ($1, $2, 'user', $3, $5), ($1, $2, 'assistant', $4, $5)`,
      [userId, safeConversationId, safeUserMessage, safeAssistantMessage, metadata],
    );

    await this.prune(userId, safeConversationId);

    return {
      success: true,
      conversationId: safeConversationId,
    };
  }

  async prune(userId, conversationId) {
    const keepLimit = normalizeKeepLimit(process.env.MEMORY_KEEP_LIMIT);
    await query(
      `DELETE FROM travel_user_memories
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS row_num
           FROM travel_user_memories
           WHERE user_id = $1 AND conversation_id = $2
         ) ranked
         WHERE ranked.row_num > $3
       )`,
      [userId, conversationId, keepLimit],
    );
  }

  async clear(userId, conversationId) {
    const safeConversationId = normalizeConversationId(conversationId);
    await query(
      `DELETE FROM travel_user_memories
       WHERE user_id = $1 AND conversation_id = $2`,
      [userId, safeConversationId],
    );

    return {
      success: true,
      conversationId: safeConversationId,
    };
  }
}

export default new UserMemoryServer();
