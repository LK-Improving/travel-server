---
name: api-backend-delivery
description: 根据确认的需求和接口契约交付 travel-server 的 Express 路由、服务、OpenAPI、数据变更和定向验证。
---

# 后端 API 交付

适用于已具备需求设计与接口契约的后端实现。实施前读取 `.agents/repowiki.md`、`.agents/rules/express-layer.mdc`、`.agents/rules/api-contract.mdc`；涉及数据变更时再读取 `.agents/rules/database-migration.mdc`。

1. 引用已确认需求和契约路径，识别兼容性与调用方影响。
2. 路由只处理协议、基础校验和鉴权；业务流程放进服务；数据访问和外部 SDK 留在基础能力边界。
3. 同步更新 `src/swagger.js`，并为 SSE 使用现有流工具、明确定义完成/错误/断连处理。
4. 数据结构变化只新增 migration，确保用户数据按认证上下文隔离。
5. 执行与改动直接相关的检查或接口验证，记录实际命令和结果；当前 `npm test` 不可作为通过依据。
