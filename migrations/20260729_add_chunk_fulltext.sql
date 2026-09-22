-- 混合检索：为切片正文启用 pg_trgm 稀疏（关键字）召回。
-- pg_trgm 基于三元组相似度，对中文关键字重叠有效且无需分词扩展；
-- word_similarity 支持“查询词与正文任意子串”的最佳匹配，适合短问题命中长切片。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN + gin_trgm_ops 索引，支撑 word_similarity / % 运算符在数据增长后的检索性能。
CREATE INDEX IF NOT EXISTS idx_travel_chunks_content_trgm
  ON travel_document_chunks USING gin (content gin_trgm_ops);
