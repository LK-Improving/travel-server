# travel-server

智能旅行 RAG 平台服务端。

- **起源**：功能完整复刻自 Python 版 `travel-python`（FastAPI + LangGraph，31 张表、60+ 端点，含多租户 / 评测 / 审计 / Agent）。
- **框架**：已在地将 Express 版改造为 **Next.js 16 App Router + TypeScript**，Route Handlers 天然承担 SSE 流式与 REST。
- **基础设施**：全量对齐 Python 版 —— Milvus（向量）、Elasticsearch（稀疏/全文）、PostgreSQL（业务 + LangGraph checkpoint）、Redis / BullMQ（异步任务队列，替代 RQ）、MinIO（对象存储）。

> 说明：原 Express 版自带的 `favorites` / `memories` / `travel` 三个模块在 Python 版中并不存在，迁移时按用户决策**保留**，并按 Next.js Route Handler 重写（见下文「保留的 Node 版模块」）。

## 技术栈

- Next.js 16（App Router）+ TypeScript（strict）
- LangGraph JS（`@langchain/langgraph` + Postgres checkpoint，与 Python 版共用表结构，会话可跨语言恢复）
- Milvus `@zilliz/milvus2-sdk-node`、Elasticsearch（fetch 直连）、BullMQ + ioredis、MinIO `minio`
- PostgreSQL `pg` 连接池、JWT `jose`、精确金额 `decimal.js`、校验 `zod`
- 混合检索（稠密 + 稀疏 + RRF + rerank）、意图分类、上下文压缩、Skill 系统、工具策略审批、韧性治理（限流 / 熔断 / 缓存）

## 目录结构

```txt
app/api/                # Next.js Route Handlers（REST + SSE）
  auth/                 # 注册 / 登录 / 当前用户
  admin/                # 运营台：知识库、文档、评测、检索调试、审计、模型路由、项目、Agent
  rag/                  # RAG 对话 / 工具 / 技能
  platform/agent/       # 平台 Agent（含工具审批）
  public/projects/      # 面向 C 端的多租户项目对话
  favorites/            # 用户收藏（保留模块）
  memories/             # 用户长短记忆（保留模块）
  travel/               # 旅游规划推荐 + 流式对话（保留模块）
lib/
  config.ts             # 运行时配置（全部从环境变量读取）
  errors.ts             # 统一错误类型与信封
  http.ts               # 响应信封 / CORS / 鉴权解析 / SSE 适配
  sse.ts                # SSE 事件序列化（与 Python 版对齐）
  db/pool.ts            # pg 连接池
  infra/                # milvus / elasticsearch / objectStorage / queue / checkpointer
  auth/                 # token / passwords / subject（请求主体解析）
  repositories/         # 32 张表的持久化访问
  services/             # 业务逻辑：rag / llm / vectorStore / projects / admin / evaluation / agent runner / travel / favorites / userMemory ...
  skills/               # 预算 / 行程规划 / 行程调整 Skill 注册
  rag_base/             # 共享的 Agent 图、上下文管理、工具
  utils/                # zodJson / json 等
worker/                 # BullMQ 消费端（文档入库、评估等异步任务）
scripts/                # 数据库初始化、Agent 运行时初始化、ES / Milvus 重建索引
migrations/             # 增量 SQL（含 Python 版迁移逐条对齐）
```

## 环境变量

密钥仅在运行时从环境变量读取，不写入代码或版本库。核心变量如下（前缀 `DEEPSEEK_/GJLD_/XIAOMI_` 的供应商配置沿用例）。

| 分类 | 变量 |
| --- | --- |
| 服务 | `PORT`、`CORS_ORIGINS` |
| 数据库 | `DATABASE_URL`（业务）、`PG_URL`、`AUTH_DB_URL`、`AUTH_DB_PASSWORD`、`AUTH_TOKEN_SECRET` |
| 模型 | `MODEL_PROVIDER`（`DEEPSEEK`/`GJLD`/`XIAOMI`）、`MODEL_MAX_TOKENS`、`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES`、`PLANNER_MODEL`、`ANSWER_MODEL`、`INTENT_MODEL`、`SUMMARY_MODEL`、`TOOL_MODEL`、`MEMORY_JUDGE_MODEL`、`MODEL_FALLBACK` |
| Embedding / Rerank | `EMBEDDING_MODEL`、`EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_DIMENSION`、`EMBEDDING_BATCH_SIZE`、`RERANK_*` |
| 向量 | `MILVUS_HOST`/`MILVUS_PORT`/`MILVUS_USER`/`MILVUS_PASSWORD`、`MILVUS_SEARCH_EF` |
| 检索 | `ELASTICSEARCH_URL`、`ELASTICSEARCH_API_KEY`、`RAG_CHUNK_SIZE`、`RAG_MATCH_COUNT`、`RAG_HYBRID_ENABLED`、`RAG_RERANK_ENABLED`、`RAG_RRF_K` 等 |
| 对象存储 | `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_ACCESS_KEY`、`OBJECT_STORAGE_SECRET_KEY`、`OBJECT_STORAGE_REGION`、`OBJECT_STORAGE_SECURE` |
| 队列 | Redis（BullMQ 复用 `DATABASE_URL` 之外的独立 Redis，由 `lib/infra/queue.ts` 配置） |
| 地图 | `AMAP_API_KEY`、`AMAP_MCP_ENABLED`、`AMAP_MCP_API_KEY` |
| Agent | `AGENT_CHECKPOINT_DB_URL`、`AGENT_SSE_HEARTBEAT_MS` |
| 记忆（保留模块） | `MEMORY_MESSAGE_LIMIT`、`MEMORY_SUMMARY_THRESHOLD`、`MEMORY_KEEP_LIMIT`、`MEMORY_KEEP_MESSAGES`、`MEMORY_REDUNDANT_THRESHOLD`、`MEMORY_NOVEL_THRESHOLD` |

> 完整清单见 `lib/config.ts`（单一事实来源）。

## 数据库初始化

```bash
npm run db:init                # 执行 migrations，创建 31+ 张业务表
npm run db:init-agent-runtime  # 初始化 LangGraph checkpoint / Agent 运行时表
npm run reindex:es             # 重建 Elasticsearch 索引
npm run reindex:milvus         # 重建 Milvus 已发布向量
```

迁移脚本从 Python 版逐条对齐（含 `travel_favorites`、`travel_user_memories`、`travel_user_memory_summaries` 等保留模块表），密码哈希向后兼容 Node 版 scrypt 格式，已有账号可直接登录。

## 开发 / 构建

```bash
npm install
npm run dev      # next dev -p 8000
npm run build    # next build
npm start        # next start -p 8000
npm run worker   # 启动 BullMQ 消费端（另开一个进程）
npm run typecheck
```

默认服务地址：`http://localhost:8000`。

## API 概览

所有响应统一信封：`{ "success": boolean, "data": ... }`；错误返回对应 HTTP 状态码 + `{ "success": false, "error": ... }`。鉴权为 `Bearer <JWT>`，平台 Agent 额外支持 `X-Client-Id`。

- 鉴权：`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`
- 运营台：`/api/admin/*`（知识库、文档、检索调试、评测运行、审计日志、模型选项 / 路由、项目与版本、Agent）
- RAG：`POST /api/rag/chat`、`GET /api/rag/tools`、`GET /api/rag/skills`
- 平台 Agent：`POST /api/platform/agent/chat`、`/api/platform/agent/approvals/:id`
- C 端项目：`/api/public/projects/:id/conversations/:cid/chat`
- 保留模块：`GET/POST /api/favorites`、`DELETE /api/favorites/:id`、`GET/DELETE /api/memories`、`GET /api/memories/summary`、`POST /api/travel/recommand`、`POST /api/travel/chat`（SSE）

### 保留的 Node 版模块（Python 版无对应）

- **收藏** `favorites`：按 `user_id + target_type + target_id`（非空）去重，重复收藏更新而非报错。
- **记忆** `memories`：短期窗口（`travel_user_memories` 近 N 条）+ 长期摘要（`travel_user_memory_summaries`，由 LLM 增量压缩）。
- **旅游规划** `travel`：
  - `POST /api/travel/recommand` —— 按城市 / 预算 / 天数生成结构化 JSON 行程（沿用原拼写 `recommand` 以兼容既有前端）。
  - `POST /api/travel/chat` —— SSE 流式对话；登录后自动注入并落盘用户记忆。SSE 事件：`chunk` / `complete` / `error` / `end`。

## 部署

基于 Next.js，部署到 Vercel / 自建 Node 服务时由平台自动识别，**无需** 旧版 `vercel.json` 的 `/(.*)->/api` 全量重写（该重写会破坏 App Router 路由，已删除）。环境变量按上表在部署平台配置，不要提交真实密钥。

## 迁移说明

从 Python 版 `travel-python` 的复刻映射、基础设施对接要点、会话与密码兼容性等，见 [`MIGRATION.md`](./MIGRATION.md)。
