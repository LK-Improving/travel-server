# #7 chunk_id 归一化重灌 · 本机执行 Runbook

> 适用场景：`buildChunkId` 已改为输出带连字符的 `8-4-4-4-12` UUID，但 Milvus / ES 中仍可能残留
> 历史「32 位无连字符 hex」主键切片。重灌使三处 `chunk_id` 表示与 PG（UUID 列，始终 hyphenated）
> 完全一致，消除跨存储比对不一致（曾导致评测里 ES 命中率被误判为 0）。

## 0. 前置条件

- 已切到目标分支（`main`）且工作树干净（`git status` 无未提交改动）。
- 基础设施齐备且可达：
  - **PostgreSQL**（`travel` 库，`travel_document_chunks.chunk_id` 为 `UUID` 列）
  - **Milvus**（默认 19530；`MILVUS_*` 环境变量已配）
  - **Elasticsearch**（已建索引；`ELASTICSEARCH_*` 已配）
  - **embedding 模型** `BAAI/bge-m3`（重灌 Milvus 需要重新向量化）
- `.env` 中 `DATABASE_URL` / `MILVUS_*` / `ELASTICSEARCH_*` 指向本机/服务器实例。
- 建议：**低流量期执行**。Milvus 重灌会先整体 `dropCollection`，重建窗口内 Milvus 短暂为空，
  稠密检索召回临时下降。ES 重灌先 `deleteIndex`，稀疏检索（若 A/B 走 ES 臂）同样短暂回落到 `pg_trgm` 兜底。

## 1. 安装依赖（如未装）

```bash
npm install
```

## 2. 一键校验当前状态（重灌前先看一眼）

```bash
npm run verify:chunk-id
```

- 输出 `[PASS]/[FAIL]/[SKIP]` 三项：PG（权威源）、Milvus、ES。
- 关注 `orphans` 列：`>0` 表示仍有 32-hex 孤儿；`total` 与「期望」不符也会 FAIL。
- 若三处均 PASS，说明已归一化，**无需重灌**，跳到 §6。

## 3. 重灌 Elasticsearch（全量、安全）

```bash
npm run reindex:es
# 大库可调分页：ES_REINDEX_PAGE=1000 npm run reindex:es
```

- 脚本循环前 `deleteIndex()` 整体删索引再重建 → 旧 32-hex 文档被整体清除，无残留。
- `chunkId` 取自 PG（hyphenated），写入 ES 的 `_id` 与 `chunk_id` 字段。

## 4. 重灌 Milvus（先整体 drop 再重建）

```bash
# 默认仅 published 切片（与线上检索口径一致）
npm run reindex:milvus

# 想更彻底（连未发布切片一并回灌，确保 Milvus 中零 32-hex）：
MILVUS_REINDEX_ONLY_PUBLISHED=false npm run reindex:milvus

# 大库可调分页：
MILVUS_REINDEX_PAGE=500 npm run reindex:milvus
```

- 关键修复：`reindexPublishedMilvus.ts` 现**先 `dropCollection()` 再 `ensureCollection()`**，
  与 ES 端 `deleteIndex()` 对齐为真正全量重建。原因：Milvus 以 `chunk_id` 为 VarChar 主键，
  旧 32-hex 与新 hyphenated 是**不同主键**，纯 `upsert` 无法覆盖旧主键，旧向量会作为孤儿残留。
- PG 是唯一权威源，drop 后从 PG 重读即可完整恢复，**无数据丢失**。

## 5. 重灌后再次校验

```bash
npm run verify:chunk-id
```

期望结果：

| 项 | total | orphans | 期望 |
| --- | --- | --- | --- |
| PG (权威源) | T | 0 | published = P |
| Milvus | P 或 T | 0 | 取决于是否含未发布 |
| ES | T | 0 | = PG 总数 T |

- `orphans` 全为 `0` 且数量对得上 → **PASS**，归一化完成。
- 若 Milvus/ES 仍 `orphans>0`：确认第 3/4 步确实跑完（看脚本末行「完成，共 N 个切片」），再重跑校验。
- 若数量不符（非孤儿原因）：检查是否有文档处于 `draft`/未发布态，或 Milvus 是否用了全量回灌开关。

## 6. 收尾

- 重灌无需改业务代码；检索链路（dense + sparse/ES + RRF + rerank）无需变更。
- 若本次是在修复后的首次全量重灌，建议在评测集上复跑稀疏召回验证：
  ```bash
  npm run eval:keyword        # pg_trgm vs ES 命中率对照
  npm run smoke:hybrid        # 混合检索端到端冒烟
  ```
- 代码改动已提交（见 `MIGRATION.md` 的「#7」节）：`lib/infra/milvus.ts`（新增 `dropCollection`/`hasCollection`/`scanChunkIds`）、
  `lib/infra/elasticsearch.ts`（新增 `listAllChunkIds`）、`scripts/reindexPublishedMilvus.ts`、
  `scripts/verifyChunkIdNormalization.ts`（新增一键校验）、`package.json`（新增 `verify:chunk-id`）。

## 故障排查

- **Milvus `collection 不存在`**：说明尚未 `reindex:milvus`，先执行 §4。
- **ES `连接/查询失败`**：检查 `ELASTICSEARCH_URL` 与索引名 `ELASTICSEARCH_INDEX`，确认 ES 已起且索引可写。
- **PG 连接失败**：检查 `DATABASE_URL` 指向的库是否为含 `travel_document_chunks` 的实例。
- **embedding 报错**：确认 `EMBEDDING_MODEL` / Ollama 端 `BAAI/bge-m3` 可用（重灌 Milvus 必经向量化）。
