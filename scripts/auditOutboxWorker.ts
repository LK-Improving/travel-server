/**
 * 审计 outbox 排空 worker（npm run audit:outbox）。
 *
 * travel_audit_outbox 由两类事件入队：
 *   - 'audit'          运营台/项目管理写操作（adminRepo.enqueueAuditOutbox / projects.ts）
 *   - 'record_tool_call' 工具授权与执行（tool_policy.ts）
 * 本 worker 周期性 claim 一批事件，按 event_method 分发到 audit() / recordToolCall()，
 * 成功则 completeAuditOutbox，失败则 failAuditOutbox（按 max_attempts 退避重试，超限进 dead_letter）。
 *
 * 与文档解析 worker（npm run worker，依赖 Redis/BullMQ）解耦——本 worker 仅依赖 Postgres。
 * 生产环境需与 npm run worker 一同常驻运行。
 *
 * 用法：
 *   npm run audit:outbox
 *   AUDIT_OUTBOX_POLL_MS=2000 AUDIT_OUTBOX_BATCH=100 npm run audit:outbox
 */
import { claimAuditOutbox, completeAuditOutbox, failAuditOutbox, audit } from '@/lib/repositories/adminRepo';
import { recordToolCall } from '@/lib/repositories/conversations';

const POLL_MS = Math.max(100, Number(process.env.AUDIT_OUTBOX_POLL_MS ?? 1000));
const BATCH = Math.min(500, Math.max(1, Number(process.env.AUDIT_OUTBOX_BATCH ?? 50)));

type Event = {
  id: string;
  method: 'audit' | 'record_tool_call';
  payload: Record<string, unknown>;
  attemptCount: number;
};

async function dispatch(event: Event): Promise<void> {
  if (event.method === 'audit') {
    await audit({
      actorId: (event.payload.actor_id as string | null) ?? null,
      action: String(event.payload.action ?? ''),
      targetType: String(event.payload.target_type ?? ''),
      targetId: event.payload.target_id != null ? String(event.payload.target_id) : null,
      status: String(event.payload.status ?? 'succeeded'),
      durationMs: event.payload.duration_ms != null ? Number(event.payload.duration_ms) : null,
      details: (event.payload.details as Record<string, unknown> | null) ?? null,
    });
    return;
  }
  if (event.method === 'record_tool_call') {
    await recordToolCall({
      conversationId: (event.payload.conversation_id as string | null) ?? null,
      actorKey: (event.payload.actor_key as string | null) ?? null,
      toolName: String(event.payload.tool_name ?? ''),
      argumentsSummary: (event.payload.arguments_summary as Record<string, unknown>) ?? {},
      resultSummary: (event.payload.result_summary as Record<string, unknown>) ?? {},
      status: String(event.payload.status ?? 'succeeded'),
      durationMs: Number(event.payload.duration_ms ?? 0),
      errorMessage: (event.payload.error_message as string | null) ?? null,
    });
    return;
  }
  throw new Error(`未知审计事件类型：${String((event as { method: string }).method)}`);
}

async function tick(): Promise<number> {
  const events = await claimAuditOutbox(BATCH);
  for (const event of events) {
    try {
      await dispatch(event);
      await completeAuditOutbox(event.id);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 160);
      // 退避重试：2^attempt 秒，上限 60s；failAuditOutbox 内部在 attemptCount>=max_attempts 时置 dead_letter。
      const nextAttemptAt = new Date(Date.now() + Math.min(2 ** event.attemptCount * 1000, 60_000));
      await failAuditOutbox(event.id, message, nextAttemptAt);
    }
  }
  return events.length;
}

let running = true;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[audit:outbox] 收到 ${signal}，准备停止…`);
    running = false;
  });
}

async function main(): Promise<void> {
  console.log(`[audit:outbox] 启动：轮询间隔 ${POLL_MS}ms，批量 ${BATCH}`);
  while (running) {
    try {
      const processed = await tick();
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    } catch (error) {
      console.error('[audit:outbox] tick 失败：', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  console.log('[audit:outbox] 已停止');
  process.exit(0);
}

void main();
