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

**遗留（未修，需确认后处理）**：`lib/repositories/adminRepo.ts` 的 `audit()` 目前**无任何调用方**，运营台的建库/上传/发布等写操作不落审计日志（审计列表接口正常但恒为 0 条）；仅工具调用经 `enqueueAuditOutbox` 记录。是否给管理端写操作接上审计待定。

### #5 / #6 小改（2026-09-24 完成，未独立提交）

- **#5 ES `fuzziness:1` 修正 2 字错字召回**：`lib/infra/elasticsearch.ts` 稀疏检索 `should` 子句的 `fuzziness` 由写死 `'AUTO'` 改为由新配置 `RAG_ES_FUZZINESS`（默认 `1`）驱动（`lib/config.ts` 新增 `ragEsFuzziness`）。`AUTO` 对 ≤2 字 token 给 0 编辑距离，无法覆盖 2 字错字（南寻→南浔、西胡→西湖）；显式 `1` 使这类 1 字替换可被 ES 独立模糊召回，不再只靠 `pg_trgm_fallback`。该子句本就是 `must` 之外的纯加分项，不伤精度。token 级对照验证：`南寻` 查询 `AUTO` 命中 14、`fuzziness:1` 命中 103（差异即 `寻→浔` 的 1 编辑距离纠正）。详见 `eval/es-vs-pg_trgm-comparison.md` §13。
- **#6 放宽城市级 `regions` 过滤**：新增迁移 `migrations/20260921_relax_regions_check.sql`，删除 `travel_documents` / `travel_document_chunks` / `travel_user_preferences` / `travel_suggested_questions` 四表的 `*_region_values_check` 取值白名单（杭州 13 区县），保留 `cardinality(regions) <= 3` 数量上限与 `NOT NULL`；应用层无取值校验，放松后 `regions` 可存任意地市/区县名，城市级过滤立即可用。`scripts/ingestCityDocs.ts` 同步把 `meta.city` 写入 `regions`。迁移已在本地 `travel` 库执行并确认约束已移除。详见 `eval/es-vs-pg_trgm-comparison.md` §14。

> 注意：#5/#6 改完 `npm run typecheck` 0 错误；本次改动较小、相互正交，与既有提交一起评审/合入即可，未单独成提交。
