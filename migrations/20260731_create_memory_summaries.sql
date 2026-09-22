-- 会话长期摘要表：ConversationSummaryBufferMemory 的持久化等价物
-- 短期窗口注入近 N 条原文，超出部分由 LLM 压缩进 summary，上下文成本 O(1)
CREATE TABLE IF NOT EXISTS travel_user_memory_summaries (
  user_id UUID NOT NULL REFERENCES travel_users(id) ON DELETE CASCADE,
  conversation_id VARCHAR(64) NOT NULL DEFAULT 'default',
  summary TEXT NOT NULL,
  -- 已被摘要覆盖到的消息时间点，用于增量摘要（只压缩新增消息）
  covered_until TIMESTAMPTZ NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);
