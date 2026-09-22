/**
 * SSE 事件序列化。三类 emitter 与 Python 版 app/utils/sse.py 完全对齐，
 * 前端按事件名和 seq 去重，字段不得随意改名。
 */
/**
 * 事件负载类型。值域放宽到 unknown：
 * 领域对象（RetrievalSource、ConversationRecord 等）没有索引签名，
 * 卡成 Json 会让每个 emitter 调用点都要做无意义的类型断言。
 * 真正的序列化约束由 JSON.stringify 在运行期保证。
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: unknown };

function serialize(value: Json): string {
  return JSON.stringify(value);
}

export interface AgentEventPayload {
  type: string;
  requestId: string;
  messageId: string;
  seq: number;
  timestamp: number;
  data: Json;
}

export interface PlatformEventPayload {
  type: string;
  requestId: string;
  threadId: string;
  seq: number;
  timestamp: number;
  data: Json;
}

export interface ProjectEventPayload extends PlatformEventPayload {
  projectId: string;
  projectVersionId: string;
}

function frame(eventType: string, payload: unknown, seq: number): string {
  return `id: ${seq}\nevent: ${eventType}\ndata: ${serialize(payload as Json)}\n\n`;
}

export function plainEvent(payload: Json): string {
  return `data: ${serialize(payload)}\n\n`;
}

export function plainError(message: string): string {
  return `event: error\ndata: ${serialize({ type: 'error', message })}\n\n`;
}

export function plainEnd(): string {
  return 'event: end\ndata: {"type":"end"}\n\n';
}

/** /api/rag/chat 使用：connected / intent / chunk / plan_result / tool_result / sources / context / complete / error / end */
export function agentEvent(
  eventType: string,
  data: Json,
  requestId: string,
  messageId: string,
  seq: number,
  timestamp: number = Date.now(),
): string {
  const payload: AgentEventPayload = { type: eventType, requestId, messageId, seq, timestamp, data };
  return frame(eventType, payload, seq);
}

/** /api/platform/agent/chat 使用：status / chunk / approval_required / complete / error / end */
export function platformEvent(
  eventType: string,
  data: Json,
  requestId: string,
  threadId: string,
  seq: number,
  timestamp: number = Date.now(),
): string {
  const payload: PlatformEventPayload = { type: eventType, requestId, threadId, seq, timestamp, data };
  return frame(eventType, payload, seq);
}

/** /api/public/projects/{id}/conversations/{cid}/chat 使用：status / sources / chunk / complete / error / end */
export function projectEvent(
  eventType: string,
  data: Json,
  requestId: string,
  threadId: string,
  projectId: string,
  projectVersionId: string,
  seq: number,
  timestamp: number = Date.now(),
): string {
  const payload: ProjectEventPayload = {
    type: eventType,
    projectId,
    projectVersionId,
    requestId,
    threadId,
    seq,
    timestamp,
    data,
  };
  return frame(eventType, payload, seq);
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** 递增序号发生器，保证单个 SSE 连接内 seq 单调递增。 */
export function createSeq(): () => number {
  let seq = 0;
  return () => {
    seq += 1;
    return seq;
  };
}
