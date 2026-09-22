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
- [ ] 运行时核心端点（鉴权、知识库、文档摄取、混合检索、RAG/Agent 流式、会话记忆、审计）—— 需在具备 DB / Milvus / ES / Redis / LLM 的环境启动后联调
