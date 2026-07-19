# travel-server 架构 Wiki

## 1. 项目定位与运行时

`travel-server` 是旅游规划后端：提供行程推荐、普通/RAG/Agent 流式对话、认证、收藏和对话记忆。运行时为 Node.js ESM；`npm run dev` 启动 nodemon，`npm start` 执行 `src/index.js`，`api/index.js` 用于 Vercel Serverless 入口。

外部依赖包括 OpenAI-compatible LLM、Embedding 服务、PostgreSQL 用户数据，以及 Supabase PostgreSQL/pgvector RAG 数据。环境变量只从 `.env` 读取，真实凭据不得写入仓库。

## 2. 源码分层

```text
src/app.js（Express 装配、全局中间件、路由和 Swagger）
  -> src/routers/（HTTP/SSE 协议、基础校验、鉴权选择）
    -> src/services/*Server.js（认证、收藏、记忆、LLM、RAG、Agent 业务编排）
      -> src/services/*Client.js、*Store.js、agentTools.js、authToken.js、src/utils/
        -> PostgreSQL、Supabase pgvector、LLM/Embedding 与外部工具
```

路由不得直接写 SQL、模型提示词或外部 SDK 调用；服务不得依赖 Express 的 `req`、`res`；`streamUtils.js` 与 `agentStreamUtils.js` 是 SSE 事件和连接生命周期的统一边界。

## 3. 模块与路由

| 模块或路径 | 文件/目录 | 职责 |
| --- | --- | --- |
| 应用装配 | `src/app.js`、`src/index.js` | 中间件、CORS、Swagger 和路由挂载；监听端口。 |
| 接口文档 | `src/swagger.js` | OpenAPI 3.0 定义，运行时暴露 `/api-docs.json` 和 `/api-docs`。 |
| 认证与用户数据 | `src/routers/auth.js`、`favorites.js`、`memories.js` | 注册、登录、当前用户、收藏及对话记忆。 |
| 旅行与流式对话 | `src/routers/travel.js`、`travelRag.js`、`travelAgent.js` | 推荐、普通/RAG/Agent SSE 入口。 |
| 业务服务 | `src/services/` | LLM、RAG、Agent、用户业务和存储访问编排。 |
| 协议与鉴权 | `src/middlewares/`、`src/utils/` | Bearer token 登录态与两种 SSE 事件封装。 |
| 数据结构 | `migrations/`、`scripts/initAuthDb.js` | PostgreSQL 用户功能表及本地初始化。 |

## 4. 数据、接口与鉴权

- OpenAPI JSON 是接口的第一事实来源；`src/swagger.js` 更改后，契约与调用方必须同步。
- `/api/auth` 管理 token；`requireAuth` 用于保护收藏和记忆，`optionalAuth` 允许普通旅行聊天在登录后追加记忆。
- 用户边界必须以 `req.auth.user.id` 为准，不信任客户端传入的用户 ID。
- 用户/收藏/记忆使用 PostgreSQL；RAG 文档与向量检索使用 Supabase pgvector。两套数据源的迁移、权限和备份需分别确认。

## 5. 异步、流式与第三方边界

- `/api/travel/chat` 与 `/api/travel-rag/chat` 使用普通 SSE；`/api/travel-agent/chat` 使用带 `requestId`、`messageId` 和 `seq` 的 Agent SSE。
- SSE 变更需保证连接、业务事件、完成、错误与断连的顺序和兼容性；部署反向代理必须关闭响应缓冲。
- 天气、POI、路线工具当前包含教学模拟实现；没有接入真实数据源前不得宣称为实时结果。

## 6. 开发约定与风险

- 文件沿用现有 camelCase `.js` 命名；路由前缀使用 kebab-case。
- 新接口同步更新路由、服务、OpenAPI、归一化契约和受影响调用方；新表结构只通过新 migration 演进。
- 最小运行检查：`npm start` 或与变更直接相关的脚本/接口检查。`npm test` 当前固定失败，尚无测试套件。
- 已知风险：缺少自动化测试；SSE 事件信封存在两种格式；Supabase 安全策略与生产部署拓扑未在仓库中体现。
