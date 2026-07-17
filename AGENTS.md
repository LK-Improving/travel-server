# 项目代理规则

## 项目事实

- 技术栈：Node.js ESM、Express 4、OpenAPI 3.0、SSE、LangChain、PostgreSQL、Supabase pgvector。
- 入口与主要目录：应用装配在 `src/app.js`，进程入口为 `src/index.js`；HTTP 路由在 `src/routers/`，业务服务在 `src/services/`，中间件在 `src/middlewares/`，SSE 工具在 `src/utils/`，数据库变更在 `migrations/`。
- API 与文档来源：运行时 OpenAPI 源为 `src/swagger.js`，访问地址为 `/api-docs.json`；Swagger UI 位于 `/api-docs`。

## 最小上下文

- 先读取目标文件、其直接调用处以及关联路由、服务或 migration。
- 涉及跨模块、路由、接口、数据或架构变更前，读取 `.agents/repowiki.md`。
- 保留现有未提交改动，只修改任务范围内文件；不得提交密钥、令牌、数据库连接串或生产配置。

## 规则与技能路由

- 修改 `src/app.js`、`src/index.js`、`src/routers/`、`src/services/`、`src/middlewares/` 或 `src/utils/`：读取 `.agents/rules/express-layer.mdc`。
- 新增或调整 HTTP/SSE 接口、`src/swagger.js`、鉴权、错误响应或前端调用：读取 `.agents/rules/api-contract.mdc`。
- 修改 `migrations/`、`scripts/initAuthDb.js`、`postgresClient.js` 或 Supabase 表初始化：读取 `.agents/rules/database-migration.mdc`。
- 需求、接口、后端实现或联调跨角色交接：读取 `.agents/rules/artifact-handoff.mdc`。
- 将业务需求沉淀为可交付设计：使用 `.agents/skills/prd-to-design/SKILL.md`。
- 将 Swagger/OpenAPI/Markdown 归一为接口契约：使用 `.agents/skills/api-docs-to-contract/SKILL.md`。
- 根据已确认需求与契约实施后端：使用 `.agents/skills/api-backend-delivery/SKILL.md`。
- 跨系统联调和验收：使用 `.agents/skills/integration-acceptance/SKILL.md`。

## 交付与验证

- 审查本次差异的范围、鉴权与数据边界、接口兼容性、SSE 生命周期和回归风险。
- 运行与改动直接相关的检查；`npm test` 目前未配置可执行测试，不将其作为通过依据。
- 最终说明实际改动、已执行验证和未验证风险。
