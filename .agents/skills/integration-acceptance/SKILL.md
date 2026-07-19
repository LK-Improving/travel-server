---
name: integration-acceptance
description: 对 travel-server 与调用方或外部依赖执行接口联调，并输出可追溯的验收报告或阻塞项。
---

# 联调与验收

适用于后端与前端、Apifox 或外部服务的联调。先读取 `.agents/rules/artifact-handoff.mdc` 和 `.agents/rules/api-contract.mdc`。

1. 引用需求设计、接口契约、OpenAPI 版本和部署/环境前提。
2. 覆盖路径、方法、字段、鉴权、成功、校验失败、鉴权失败、空态、重复提交和数据库影响。
3. 对 SSE 覆盖连接、业务事件顺序、完成、错误、取消及代理关闭缓冲的前提。
4. 将结果写入 `.agents/Documents/需求分析/联调验收/YYYY-MM-DD-主题.md`，区分已验证、未验证、失败/阻塞项及证据。
5. 不把未配置的密钥、不可访问的外部服务或未执行检查写成通过；将阻塞回流给对应需求或契约负责人。
