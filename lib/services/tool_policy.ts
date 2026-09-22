// 租户感知的工具鉴权与可审计 LangChain 包装（对齐 Python app/services/tool_policy.py）。
import type { StructuredTool } from '@langchain/core/tools';
import { config } from '../config';
import { queryOne } from '../db/pool';
import { enqueueAuditOutbox } from '../repositories/adminRepo';
import { listToolPolicyDecisions, createToolApproval, approveToolApproval } from '../repositories/platform';
import type { ToolPolicyDecision, ToolApprovalRecord } from '../repositories/platform';
import { ApprovalRequiredError, PermissionError } from '../errors';

export interface ToolExecutionContext {
  tenantId: string;
  applicationId: string;
  actorId: string;
  role: string;
  conversationId?: string | null;
  traceId?: string | null;
  approvalToken?: string | null;
}

export class ToolPolicyService {
  async authorize(context: ToolExecutionContext, toolName: string, args?: Record<string, unknown> | null): Promise<void> {
    const rules = await listToolPolicyDecisions(context.tenantId, context.applicationId, context.role, toolName);
    const effects = new Set(rules.map((r) => r.effect));
    if (effects.has('deny') || !effects.has('allow')) {
      throw new PermissionError('无权调用该工具');
    }
    const requiresConfirmation = rules.some((r) => r.effect === 'allow' && r.requiresConfirmation);
    if (!requiresConfirmation) return;
    if (context.approvalToken) {
      const consumed = await this.consumeToolApproval(context.approvalToken, context, toolName);
      if (consumed) return;
    }
    const approvalId = await createToolApproval({
      tenantId: context.tenantId,
      applicationId: context.applicationId,
      actorId: context.actorId,
      conversationId: context.conversationId ?? null,
      toolName,
      argumentsSummary: summarize(args ?? {}),
    });
    throw new ApprovalRequiredError(approvalId, toolName, `高风险工具需要人工确认，审批编号：${approvalId}`);
  }

  private async consumeToolApproval(token: string, context: ToolExecutionContext, toolName: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM ai_tool_approvals
       WHERE id=$1 AND tenant_id=$2 AND application_id=$3 AND actor_id=$4 AND tool_name=$5
         AND status='approved' AND expires_at>NOW()`,
      [token, context.tenantId, context.applicationId, context.actorId, toolName],
    );
    return Boolean(row);
  }
}

const SENSITIVE_KEY = /api[_-]?key|token|secret|password|credential|authorization/i;

/** 递归裁剪：截断长字符串、脱敏凭据键、限制深度，保证审计摘要可安全落库。 */
function summarizeValue(value: unknown, depth: number): unknown {
  if (depth >= 2) return '<nested>';
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return { count: value.length };
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '<redacted>' : summarizeValue(v, depth + 1)]),
    );
  }
  if (typeof value === 'string') return value.slice(0, 160);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value).slice(0, 160);
}

/** 顶层入口固定返回对象，与审计表 jsonb 列的类型一致。 */
export function summarize(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return summarizeValue(value, 0) as Record<string, unknown>;
  }
  return { value: summarizeValue(value, 0) };
}

export class PlatformToolRegistry {
  private readonly tools: Map<string, StructuredTool>;
  private readonly policy = new ToolPolicyService();
  private readonly timeoutSeconds: number;

  constructor(
    tools: StructuredTool[],
    private readonly timeoutMs: number = config.toolTimeoutMs,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.timeoutSeconds = Math.max(Number(timeoutMs), 1) / 1000;
  }

  private async audit(
    context: ToolExecutionContext,
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    status: string,
    durationMs: number,
    error?: string | null,
  ): Promise<void> {
    try {
      await enqueueAuditOutbox('record_tool_call', {
        conversation_id: context.conversationId ?? null,
        trace_id: context.traceId ?? null,
        actor_key: `user:${context.actorId}`,
        tool_name: name,
        arguments_summary: summarize(args),
        result_summary: summarize(result),
        status,
        duration_ms: durationMs,
        error_message: error ?? null,
      });
    } catch {
      // 工具授权/执行不得因审计库故障而失败；outbox 尽力而为。
    }
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const started = performance.now();
    let status = 'failed';
    let error: string | null = null;
    let result: unknown = null;
    try {
      await this.policy.authorize(context, name, args);
      const tool = this.tools.get(name);
      if (!tool) throw new Error('工具未注册');
      result = await Promise.race([
        Promise.resolve(tool.invoke(args)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('工具调用超时')), this.timeoutSeconds * 1000)),
      ]);
      status = 'succeeded';
      return result;
    } catch (exc) {
      error = String((exc as Error)?.message ?? exc).slice(0, 160);
      throw exc;
    } finally {
      await this.audit(context, name, args, result, status, Math.round(performance.now() - started), error);
    }
  }
}

export { approveToolApproval, type ToolPolicyDecision, type ToolApprovalRecord };
