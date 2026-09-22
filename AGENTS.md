# 项目代理规则

## 项目事实

- 技术栈：Next.js 16 App Router、TypeScript（strict）、LangGraph JS、Milvus、Elasticsearch、PostgreSQL、Redis/BullMQ、MinIO。由 Python 版 `travel-python` 完整复刻，并将原 Express 版改造而来。
- 入口与主要目录：HTTP 层在 `app/api/`（Route Handlers，REST + SSE）；业务逻辑在 `lib/services/`；持久化在 `lib/repositories/`（32 张表）；基础设施适配在 `lib/infra/`（milvus / elasticsearch / objectStorage / queue / checkpointer）；鉴权在 `lib/auth/`（token / passwords / subject）；Agent 图与工具在 `lib/rag_base/`；Skill 在 `lib/skills/`；数据库变更在 `migrations/`；异步消费端在 `worker/`，运维脚本在 `scripts/`。
- 响应与错误：统一信封见 `lib/http.ts`（`{ success, data }`，错误 `{ success:false, error }`）；SSE 序列化见 `lib/sse.ts`，事件字段与 Python 版对齐。
- 保留的 Node 版模块（Python 版无对应，经决策保留并按 Route Handler 重写）：`app/api/favorites`、`app/api/memories`、`app/api/travel`。

## 最小上下文

- 先读取目标文件、其直接调用处以及关联路由、服务或 migration。
- 涉及跨模块、路由、接口、数据或架构变更前，读取 `.agents/repowiki.md`。
- 保留现有未提交改动，只修改任务范围内文件；不得提交密钥、令牌、数据库连接串或生产配置。

## 规则与技能路由

- 修改 `app/api/`、`lib/services/`、`lib/repositories/`、`lib/auth/` 或 `lib/rag_base/`：遵循本仓库 Next.js Route Handler 约定（`route()` 包装器、`currentUser`/`publicSubject` 鉴权、`sseResponse` 流式）。
- 新增或调整 HTTP/SSE 接口、鉴权、错误响应：参考 `lib/http.ts` 与 `lib/sse.ts` 的既有模式，保持 `{ success, data }` 信封与 SSE 事件字段稳定。
- 修改 `migrations/`、`scripts/` 或数据库初始化：对齐 Python 版迁移，密码哈希向后兼容 Node 版 scrypt。
- 需求、接口、后端实现或联调跨角色交接：读取 `.agents/rules/artifact-handoff.mdc`。
- 将业务需求沉淀为可交付设计：使用 `.agents/skills/prd-to-design/SKILL.md`。
- 将 OpenAPI/Markdown 归一为接口契约：使用 `.agents/skills/api-docs-to-contract/SKILL.md`。
- 根据已确认需求与契约实施后端：使用 `.agents/skills/api-backend-delivery/SKILL.md`。
- 跨系统联调和验收：使用 `.agents/skills/integration-acceptance/SKILL.md`。

## 交付与验证

- 审查本次差异的范围、鉴权与数据边界、接口兼容性、SSE 生命周期和回归风险。
- 改动后运行 `npm run typecheck`（`tsc --noEmit`）与 `npm run build`（`next build`）作为通过依据；`npm test` 当前未配置可执行测试。
- 最终说明实际改动、已执行验证和未验证风险。
