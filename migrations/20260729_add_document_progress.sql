-- 文档解析进度：worker 分阶段回写，前端轮询展示
ALTER TABLE travel_documents
    ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS processing_stage TEXT;
