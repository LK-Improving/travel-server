---
name: api-docs-to-contract
description: 将 travel-server 的 OpenAPI、Apifox 或接口 Markdown 归一为可供后端和调用方使用的接口契约。
---

# 接口文档到契约

适用于新增、变更或核对接口。先读取 `.agents/rules/api-contract.mdc`。

1. 首先读取 `src/swagger.js` 或运行时 `/api-docs.json`；其次才使用 Apifox、Markdown 和截图。
2. 输出路径、方法、请求/响应字段、状态码、鉴权、空态、错误、幂等和兼容性结论。
3. 对 SSE 逐项记录事件名/类型、数据结构、事件顺序、完成、错误、取消和代理缓冲要求。
4. 将来源、版本/日期和待确认项写入 `.agents/Documents/接口设计/YYYY-MM-DD-主题-contract.md`。
5. 有冲突时停止实现并回流到需求或契约确认；不猜测未提供字段。
