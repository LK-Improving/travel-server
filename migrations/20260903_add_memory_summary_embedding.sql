ALTER TABLE IF EXISTS travel_conversation_summaries
  ADD COLUMN IF NOT EXISTS summary_embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(255),
  ADD COLUMN IF NOT EXISTS last_compacted_message_id UUID,
  ADD COLUMN IF NOT EXISTS summary_version INTEGER NOT NULL DEFAULT 1;
