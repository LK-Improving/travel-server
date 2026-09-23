/**
 * 运营台写操作审计助手。
 *
 * 通过 adminRepo.enqueueAuditOutbox('audit', ...) 把审计事件写入 travel_audit_outbox，
 * 由独立 worker（scripts/auditOutboxWorker.ts，npm run audit:outbox）异步排空并落库
 * 到 travel_admin_audit_logs。写入为 best-effort，失败不影响主操作流程。
 */
import { enqueueAuditOutbox } from '@/lib/repositories/adminRepo';

export interface AdminAuditInput {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  status?: string;
  durationMs?: number | null;
  details?: Record<string, unknown> | null;
}

export async function recordAdminAudit(input: AdminAuditInput): Promise<void> {
  try {
    await enqueueAuditOutbox('audit', {
      actor_id: input.actorId,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      status: input.status ?? 'succeeded',
      duration_ms: input.durationMs ?? 0,
      details: input.details ?? null,
    });
  } catch {
    // 审计尽力而为，outbox 写入故障不应导致主操作失败。
  }
}
