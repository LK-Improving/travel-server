-- #6 放宽城市级 regions 过滤：放开取值白名单，保留数量上限。
--
-- 背景：travel_documents / travel_chunks / travel_preferences / travel_questions 四表的
--   *region_values_check 约束用 `regions <@ ARRAY['上城','拱墅','西湖',…杭州13区县]` 把取值
--   死死钉在杭州 13 个区县，导致无法按「地市」（杭州/宁波/温州…）维度过滤与入库。
--   scripts/ingestCityDocs.ts 此前只能把地市名塞进 tags 绕开该约束。
--
-- 本次只去掉「取值白名单」，保留 cardinality(regions) <= 3 的数量上限（防止异常超大数组）。
-- 放宽后 regions 可存任意地市/区县名，配合 ES region_codes（keyword）与 PG `c.regions && $x`
-- 的重叠过滤即可实现地市级检索。应用层无任何取值校验，无需改动。
--
-- 使用 DROP CONSTRAINT IF EXISTS 保证幂等：全新库（基础迁移先建约束，本迁移再删）与
-- 已存在库（基础迁移已应用，本迁移直接删）最终状态一致。

ALTER TABLE travel_documents
  DROP CONSTRAINT IF EXISTS travel_documents_region_values_check;

ALTER TABLE travel_document_chunks
  DROP CONSTRAINT IF EXISTS travel_chunks_region_values_check;

-- 注意：偏好表实际名为 travel_user_preferences（基础迁移里约束名沿用 travel_preferences_* 前缀，与表名不一致）。
ALTER TABLE travel_user_preferences
  DROP CONSTRAINT IF EXISTS travel_preferences_region_values_check;

-- 注意：建议问题表实际名为 travel_suggested_questions（约束名沿用 travel_questions_* 前缀）。
ALTER TABLE travel_suggested_questions
  DROP CONSTRAINT IF EXISTS travel_questions_region_values_check;
