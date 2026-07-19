---
name: prd-to-design
description: 将 travel-server 的业务需求归纳为可确认的后端需求设计、接口和数据影响及验收标准。
---

# PRD 到需求设计

适用于新增旅游能力、认证/收藏/记忆变更、RAG 或 Agent 功能需求。先读取 `.agents/repowiki.md` 和相关规则；不直接修改运行时代码。

1. 说明目标、非目标、参与者、主流程、异常流程与数据边界。
2. 列出受影响路由、服务、OpenAPI、SSE、鉴权、外部服务与 migration。
3. 对每个未从需求或现有契约确认的字段、策略或第三方能力标记“待确认”。
4. 写入 `.agents/Documents/需求分析/需求/YYYY-MM-DD-主题.md`，包含可验证验收标准和上游来源。
5. 将需要确认的接口输入交给 `api-docs-to-contract`，不要在需求文档中臆造 API 细节。
