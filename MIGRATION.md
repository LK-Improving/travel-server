# 迁移说明：travel-python → travel-server（Next.js）

本文记录将 Python 版 `travel-python`（FastAPI + LangGraph）完整复刻为 Node/TypeScript，并将原 Express 版 `travel-server` 改造为 Next.js App Router 的过程与关键决策。

## 范围决策

- **基础设施**：全量对齐 —— 保留 Milvus + Elasticsearch + PostgreSQL + Redis/BullMQ + MinIO。
- **迁移范围**：全量一次性交付 —— 31 张业务表 + 60+ 端点，含多租户、评测、审计、Agent。
- **代码处置**：原地改造，保留 git 历史；完成后删除旧 Express 代码（`src/`、`api/`、`nodemon.json`、`vercel.json`、旧测试）。
- **旧功能处置**：原 Express 版自带的 `favorites` / `memories` / `travel` 三个模块在 Python 版中不存在，经确认**保留**，并按 Next.js Route Handler 重写。

## 架构对照

| 关注点 | Python 版 | Node 版（本仓库） |
| --- | --- | --- |
| Web 框架 | FastAPI | Next.js 16 App Router（Route Handlers） |
| Agent 编排 | LangGraph (Python) | LangGraph JS（`@langchain/langgraph`） |
| 会话持久化 | PostgresSaver | `@langchain/langgraph-checkpoint-postgres`，**共用表结构，会话可跨语言恢复** |
| 向量库 | Milvus | `@zilliz/milvus2-sdk-node` |
| 全文 / 稀疏 | Elasticsearch | `fetch` 直连 ES（不引入官方客户端） |
| 任务队列 | RQ | BullMQ + ioredis |
| 对象存储 | MinIO | `minio` |
| 鉴权 | Shiro + JWT（Bearer + X-Application-Key + X-Client-Id） | `jose` 签发 JWT，角色服务端解析，绝不采信客户端 role |
| 金额 | decimal | `decimal.js` |

## 关键兼容点（已验证）

1. **LangGraph checkpoint 表结构共用**：Python 与 JS 的 PostgresSaver 表结构一致，同一 `thread_id` 的会话状态可跨实现恢复。
2. **密码哈希向后兼容**：沿用 Node 版 scrypt 格式，迁移后既有账号可直接登录，无需重置。
3. **SSE 事件对齐**：`lib/sse.ts` 的 `agentEvent` / `platformEvent` / `projectEvent` 与 Python `app/utils/sse.py` 的字段（`type`/`requestId`/`messageId`/`seq`/`timestamp`）一一对应，前端可凭 `seq` 去重。
4. **混合检索一致**：稠密（Milvus）+ 稀疏（ES）+ RRF + rerank 管线参数（`RAG_*`）与 Python 版对齐。

## 保留模块重写要点

原 Express 模块与其 Python 不存在的字段一并保留，重写时做了如下收敛：

- **统一响应信封**：旧版返回 `{ code, msg }` 或裸 `{ success, data }`，新版统一为 `{ success, data }` / 错误 `{ success:false, error }`（见 `lib/http.ts`）。
- **SSE 格式**：`travel/chat` 沿用旧版 `chunk` / `complete` / `error` / `end` 事件；`rag|platform|project` 系列用带 `seq` 的结构化事件。
- **模型接入**：保留模块与全站共用 `lib/services/llm.buildChatModel`，不再各自维护 `ChatOpenAI` 实例。
- **记忆落盘**：`travel/chat` 登录后调用 `userMemoryService.rememberExchange` 写入短期记忆，并 best-effort 触发 `maybeSummarize` 增量摘要（失败不影响主链路）。

## 复刻中修复的 TypeScript 模式（供后续参考）

- 相对导入统一改为 `@/` 别名（在 `tsconfig` 增加 `baseUrl` + `paths`）。
- `successResponse` / SSE `Json` 类型放宽到 `unknown`，避免领域对象缺少索引签名导致的类型体操。
- 错误工厂为纯函数，调用处已有 `new` 的批量移除。
- `defineSkill` 的 zod 链式顺序：`min`/`max` 必须在 `default` 之前。
- LangGraph 图类型用推断别名（`RagAgentGraph`）替代 `CompiledStateGraph` 泛型。

## 删除的旧 Express 物

- `src/`（app.js / routers / services / middlewares / utils）、根 `api/index.js`、`nodemon.json`、`vercel.json`、`test/`（旧 Express 测试，引用已删服务）。
- 上述文件仍保留在 git 历史中，可随时回溯。

## 冒烟验证清单

- [x] `npm run typecheck`（`tsc --noEmit`）0 错误
- [x] `npm run build`（`next build`）40+ 路由编译通过
- [x] 旧 Express 代码已删除，git 历史保留
- [x] 运行时核心端点（鉴权、知识库、文档摄取、混合检索、RAG/Agent 流式、会话记忆、审计）—— 需在具备 DB / Milvus / ES / Redis / LLM 的环境启动后联调

### 运行时联调（2026-09-23 完成）
在 DB / Milvus / ES / Redis / LLM 齐备的环境起 `npm run dev` + `npm run worker` 后执行 `npm run smoke:runtime`（`scripts/smokeRuntime.ts`，产物 `eval/runtime-smoke.json`），关键步骤 15/15 通过：心跳、注册/登录/me、知识库列表与创建、文档上传与切片、混合检索（`ab` / `elasticsearch` / `pg_trgm` 三路均返回 5 条且 `sparseBackend` 正确）、RAG Agent SSE 流式（收到结构化事件）、记忆列表与摘要、审计日志列表。

联调中**发现并修复的真实缺陷**：
1. **文档摄取全链路不通（严重）**：`lib/infra/queue.ts` 用 `jobId: \`doc:${documentId}\`` 入队，而 BullMQ v5+ 禁止自定义 jobId 含 `:`，导致每次上传入队即失败、文档被补偿回 `draft` 并记「队列不可用，任务未启动」，永远不出切片。改为 `doc-${documentId}` 后，worker 正常消费（实测 1.4–2.6s 出切片，embedding 模型 `BAAI/bge-m3`）。
2. **重复注册返回 500**：`createUser` 抛普通 Error，冒泡成 500；已在 `app/api/auth/register/route.ts` 捕获并转为 `conflict`，语义正确为 409。
3. 环境侧：对象存储未配置时降级为**进程内内存实现**，worker 是独立进程读不到上传原文，摄取必然失败；本地联调需在 `.env` 启用 `OBJECT_STORAGE_*`（指向 MinIO）才能让两进程共享原文。

**遗留（已在 2026-09-24~25 处理，见文末「#3-A / #3-B」节）**：注册 role 锁死与运营台审计闭环均已落地。

### #5 / #6 小改（2026-09-24 完成，未独立提交）

- **#5 ES `fuzziness:1` 修正 2 字错字召回**：`lib/infra/elasticsearch.ts` 稀疏检索 `should` 子句的 `fuzziness` 由写死 `'AUTO'` 改为由新配置 `RAG_ES_FUZZINESS`（默认 `1`）驱动（`lib/config.ts` 新增 `ragEsFuzziness`）。`AUTO` 对 ≤2 字 token 给 0 编辑距离，无法覆盖 2 字错字（南寻→南浔、西胡→西湖）；显式 `1` 使这类 1 字替换可被 ES 独立模糊召回，不再只靠 `pg_trgm_fallback`。该子句本就是 `must` 之外的纯加分项，不伤精度。token 级对照验证：`南寻` 查询 `AUTO` 命中 14、`fuzziness:1` 命中 103（差异即 `寻→浔` 的 1 编辑距离纠正）。详见 `eval/es-vs-pg_trgm-comparison.md` §13。
- **#6 放宽城市级 `regions` 过滤**：新增迁移 `migrations/20260921_relax_regions_check.sql`，删除 `travel_documents` / `travel_document_chunks` / `travel_user_preferences` / `travel_suggested_questions` 四表的 `*_region_values_check` 取值白名单（杭州 13 区县），保留 `cardinality(regions) <= 3` 数量上限与 `NOT NULL`；应用层无取值校验，放松后 `regions` 可存任意地市/区县名，城市级过滤立即可用。`scripts/ingestCityDocs.ts` 同步把 `meta.city` 写入 `regions`。迁移已在本地 `travel` 库执行并确认约束已移除。详见 `eval/es-vs-pg_trgm-comparison.md` §14。

> 注意：#5/#6 改完 `npm run typecheck` 0 错误；本次改动较小、相互正交，与既有提交一起评审/合入即可，未单独成提交。

### #3-A / #3-B 安全加固与审计闭环（2026-09-25 完成）

- **#3-A 注册 role 锁死（安全修复）**：`app/api/auth/register/route.ts` 的 `RegisterSchema` 已删除 `role` 字段，调用 `createUser` 不再传 `role`（其默认即 `user`），与 `lib/auth/subject.ts`「角色一律由服务端解析，绝不采信客户端提交的 role」对齐——公开注册接口不再可被用来提权为 `admin`/`operator`/`viewer`。
  - 管理员预置改走受信任服务端通道：`scripts/seedAdmin.ts` 的 `ensureAdmin(account, password)`（直接调 `createUser({ role:'admin' })`，幂等），新增 npm 脚本 `npm run db:seed-admin`（默认用 `SMOKE_ADMIN_*` 凭据；可用 `SEED_ADMIN_*` 覆盖）。
  - 冒烟脚本 `scripts/smokeRuntime.ts` 同步改造：启动时经 `ensureAdmin` 预置管理员（不再依赖公开接口注册 admin），并新增「无 role 探测账号」回归验证（`auth.me` 角色应为 `user`，否则判异常）。
- **#3-B 运营台审计闭环**：
  - 新增 `lib/audit.ts` 的 `recordAdminAudit()`——best-effort 把审计事件写入 `travel_audit_outbox`（不阻塞主操作）。
  - 运营台写操作已接入：知识库创建/删除、文档上传/删除、推荐问题增删改（`app/api/admin/knowledge-bases`、`app/api/admin/documents`、`app/api/admin/suggested-questions` 对应 `route.ts`）。每处 `actorId` 取自 `adminWriter(request).id`，`action` 形如 `kb.create`/`document.upload`/`suggested_question.delete` 等。
  - 新增 `scripts/auditOutboxWorker.ts`（`npm run audit:outbox`）：周期性 `claimAuditOutbox` 批量领取，按 `event_method` 分发——`'audit'`→`audit()`、`'record_tool_call'`→`recordToolCall()`，成功 `completeAuditOutbox`、失败 `failAuditOutbox`（按 `max_attempts` 退避重试，超限进 `dead_letter`；`processing` 行 5 分钟超时自动回收）。**此举同时让 `projects.ts` 既有 6 处项目写审计与 `tool_policy` 工具调用审计真正落库**（此前 `claimAuditOutbox` 无调用方，outbox 从未被排空）。
  - 生产环境需与 `npm run worker` 一同常驻 `npm run audit:outbox`。
  - 说明：原「发布/下架文档」「偏好更新」在 `app/api/admin/*` 下无对应写端点（文档 `status` 仅为列表过滤条件，偏好表无 admin 路由），故未接入；如后续新增相关端点应一并补 `recordAdminAudit`。
- 验证：`npm run typecheck` 0 错误。

### #7 chunk_id 归一化重灌（2026-09-21 完成代码修正，需在有基础设施的环境执行）

- **根因**：`buildChunkId`（`lib/services/document_processing.ts:43`）现已输出带连字符的 `8-4-4-4-12` UUID 形式，但历史切片在 Milvus/ES 中以「32 位无连字符 hex」主键写入。PG `travel_document_chunks.chunk_id` 是 `UUID` 列（`migrations/20260724_...sql:113`），Postgres 始终返回带连字符形式，故不一致只存在于 **ES/Milvus 两端**，PG 始终是权威源且已 hyphenated。跨存储按 `chunk_id` 比对时 32-hex 与 hyphenated 永不相等，曾导致评测里 ES 命中率被误判为 0（见 `eval/es-vs-pg_trgm-comparison.md` §9.4）。
- **ES 重灌已安全**：`scripts/reindexElasticsearch.ts` 循环前 `deleteIndex()` 整体删索引再重建，旧 32-hex 文档被整体清除，`chunkId` 取自 PG（hyphenated），无残留。
- **Milvus 重灌原不安全（已修复）**：`scripts/reindexPublishedMilvus.ts` 原本只 `upsertChunks`（按 `chunk_id` 主键 upsert，不 drop）。旧 32-hex 与新 hyphenated 是**不同主键**，upsert 无法覆盖旧主键，旧向量会作为**孤儿向量**残留（`published=true`，仍被 `search` 命中，却对应 PG/ES 中不存在的 `chunk_id`），重灌后反而继续制造不一致。
  - 修复：新增 `lib/infra/milvus.ts` 的 `dropCollection()`，并在 `reindexPublishedMilvus.ts` 重建前先整体 `dropCollection()` 再 `ensureCollection()`，与 ES 端 `deleteIndex()` 对齐，成为真正的全量重建。PG 是唯一权威源，drop 后从 PG 重读即可完整恢复，无数据丢失。建议在低流量期执行（重建窗口内 Milvus 短暂为空，检索召回临时下降）。
- **执行（需 DB / Milvus / ES / embedding 模型 `BAAI/bge-m3` 齐备）**：
  - `npm run reindex:es` —— 全量、安全（自动 deleteIndex + 重建）。
  - `npm run reindex:milvus` —— 默认仅 published；`MILVUS_REINDEX_ONLY_PUBLISHED=false` 连未发布切片一并回灌（更彻底，确保 Milvus 中零 32-hex）。
  - 验证：Milvus 查询 `chunk_id not like "%-%"` 应为 0 行；ES `_search` 抽样 `chunk_id` 均为 hyphenated。
- 验证：`npm run typecheck` 0 错误（本次同时修复 `scripts/smokeRuntime.ts` 一个遗留类型错误：`auth.me` 步骤误将 `note` 写在 `call()` 返回值上而非 `results` 数组的 `StepResult` 上，导致 `tsc` 报 `Property 'note' does not exist`）。
- 配套一键校验：`scripts/verifyChunkIdNormalization.ts`（`npm run verify:chunk-id`）扫描 PG/Milvus/ES 三处 `chunk_id`，断言无 32-hex 孤儿且数量与权威源对齐；本机执行 runbook 见 `docs/chunk-id-reindex-runbook.md`（含重灌步骤、预期值与故障排查）。
