/**
 * JSON 边界规整。
 *
 * 项目里大量领域对象要流向三个地方：SSE 事件、Postgres JSONB 列、LangGraph 的 Json 约束。
 * 这三个地方都要求「可序列化 + 有索引签名」，而我们的领域接口（ConversationRecord 等）
 * 故意不带索引签名以保证字段精确。与其到处写 as unknown as，不如在边界统一规整一次：
 * 顺带把 undefined 和不可序列化的值（Date 转字符串、BigInt 丢精度前暴露）处理掉。
 */
export function jsonSafe<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** 同名语义化导出，用于明确「这个函数返回的是可写库的结构」。 */
export function toJsonRecord(value: unknown): Record<string, unknown> {
  const result = jsonSafe<unknown>(value);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
