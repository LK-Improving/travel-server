# travel-server 治理初始化状态

## 发现结果

- 初始化时间：2026-07-16（Asia/Hong_Kong）
- 工作区：`D:\Study\重点项目\travel-server`
- Git 状态：`.gitignore` 已修改；`AGENTS.md`、`docs/auth-api.md`、`docs/frontend-integration.md` 处于用户未提交的删除状态。
- 已识别技术栈：Node.js ESM、Express 4、OpenAPI 3.0（swagger-jsdoc / swagger-ui-express）、SSE、LangChain OpenAI-compatible LLM、PostgreSQL（`pg`）与 Supabase pgvector。
- 待确认技术栈或边界：生产部署拓扑、反向代理的 SSE 缓冲策略、Supabase RLS/备份策略、真实天气/POI/路线服务及其限流策略。

## 五阶段

- [x] 1. 项目发现与初始状态
- [x] 2. AGENTS 与架构 Wiki（根 `AGENTS.md` 的删除已保留，合并稿见 `.agents/AGENTS.md.proposed`）
- [x] 3. 技术栈规则
- [x] 4. 需求、接口与后端实现技能
- [x] 5. 后端交付、产物交接与联调验收

## 生成的文件

| 文件 | 阶段 | 说明 |
| --- | --- | --- |
| `.agents/AGENTS.md.proposed` | 2 | 根规则的合并建议；不覆盖用户删除中的 `AGENTS.md`。 |
| `.agents/repowiki.md` | 2 | 当前代码事实导出的架构索引。 |
| `.agents/rules/express-layer.mdc` | 3 | Express 分层与依赖方向。 |
| `.agents/rules/api-contract.mdc` | 3 | OpenAPI、鉴权、错误和 SSE 契约规则。 |
| `.agents/rules/database-migration.mdc` | 3 | PostgreSQL migration 与初始化约定。 |
| `.agents/rules/artifact-handoff.mdc` | 5 | 需求、契约、后端实现和验收的交接规则。 |
| `.agents/skills/*/SKILL.md` | 4-5 | 项目内需求、契约、后端交付与联调技能。 |

## 合并与待确认事项

- 根 `AGENTS.md` 被工作区删除。若确认需要恢复治理入口，请以 `.agents/AGENTS.md.proposed` 为基础人工合并；初始化未改变该用户改动。
- `docs/` 下两份历史接口文档也被删除。本次以 `src/swagger.js` 暴露的 `/api-docs.json` 作为当前接口事实来源，并未恢复这些文件。
- `npm test` 目前固定失败（未配置测试套件）；治理文件只把它记录为风险，不把它当作可用验证命令。
