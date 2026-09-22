/**
 * 平台侧数据访问：租户/应用上下文、工具策略、人工审批、向量索引与 Agent 运行记录。
 * 对应 Python 版 repositories/postgres.py 的平台域方法。
 */
import { execute, query, queryOne } from '../db/pool';

export interface PlatformApplicationContext {
  tenantId: string;
  applicationId: string;
  membershipRole: string | null;
}

export interface ToolPolicyDecision {
  effect: 'allow' | 'deny';
  requiresConfirmation: boolean;
}

export interface ActiveVectorIndex {
  backend: 'milvus' | 'pgvector';
  collectionName: string;
  embeddingModel: string;
  embeddingDimension: number;
  distanceMetric: string;
}

export interface ToolApprovalRecord {
  approvalId: string;
  toolName: string;
  conversationId: string | null;
  expiresAt: string | null;
  status: string;
}

export async function resolvePlatformApplicationContext(
  applicationKey: string,
  userId: string,
): Promise<PlatformApplicationContext | null> {
  const row = await queryOne<{ tenant_id: string; application_id: string; membership_role: string | null }>(
    `SELECT app.tenant_id,app.id AS application_id,membership.role AS membership_role
     FROM ai_applications app
     JOIN ai_tenants tenant ON tenant.id=app.tenant_id AND tenant.status='active'
     LEFT JOIN ai_memberships membership ON membership.tenant_id=app.tenant_id AND membership.user_id=$2
     WHERE app.app_key=$1 AND app.status='active'`,
    [applicationKey, userId],
  );
  if (!row) return null;
  return {
    tenantId: String(row.tenant_id),
    applicationId: String(row.application_id),
    membershipRole: row.membership_role ? String(row.membership_role) : null,
  };
}

export async function listToolPolicyDecisions(
  tenantId: string,
  applicationId: string,
  role: string,
  toolName: string,
): Promise<ToolPolicyDecision[]> {
  const rows = await query<{ effect: string; requires_confirmation: boolean }>(
    `SELECT effect,requires_confirmation FROM ai_tool_policies
     WHERE tenant_id=$1 AND application_id=$2 AND role=$3 AND tool_name=$4`,
    [tenantId, applicationId, role, toolName],
  );
  return rows.map((row) => ({
    effect: row.effect === 'deny' ? 'deny' : 'allow',
    requiresConfirmation: Boolean(row.requires_confirmation),
  }));
}

export async function listApplicationKnowledgeBases(tenantId: string, applicationId: string): Promise<string[]> {
  const rows = await query<{ knowledge_base_id: string }>(
    `SELECT knowledge_base_id FROM ai_knowledge_base_bindings
     WHERE tenant_id=$1 AND application_id=$2 ORDER BY knowledge_base_id`,
    [tenantId, applicationId],
  );
  return rows.map((row) => String(row.knowledge_base_id));
}

export async function listActorMemberships(
  actorId: string,
): Promise<Array<{ tenantId: string; role: string }>> {
  const rows = await query<{ tenant_id: string; role: string }>(
    'SELECT tenant_id,role FROM ai_memberships WHERE user_id=$1 ORDER BY tenant_id',
    [actorId],
  );
  return rows.map((row) => ({ tenantId: String(row.tenant_id), role: String(row.role) }));
}

export async function createToolApproval(options: {
  tenantId: string;
  applicationId: string;
  actorId: string;
  conversationId: string | null;
  toolName: string;
  argumentsSummary: Record<string, unknown>;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO ai_tool_approvals
       (tenant_id,application_id,actor_id,conversation_id,tool_name,arguments_summary)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [
      options.tenantId,
      options.applicationId,
      options.actorId,
      options.conversationId,
      options.toolName,
      JSON.stringify(options.argumentsSummary),
    ],
  );
  return String(row!.id);
}

export async function approveToolApproval(
  approvalId: string,
  tenantId: string,
  approvedBy: string,
): Promise<ToolApprovalRecord | null> {
  const row = await queryOne<{
    id: string;
    tool_name: string;
    conversation_id: string | null;
    expires_at: string | null;
  }>(
    `UPDATE ai_tool_approvals SET status='approved',approved_at=NOW(),approved_by=$3
     WHERE id=$1 AND tenant_id=$2 AND status='pending' AND expires_at>NOW()
     RETURNING id,tool_name,conversation_id,expires_at`,
    [approvalId, tenantId, approvedBy],
  );
  if (!row) return null;
  return {
    approvalId: String(row.id),
    toolName: String(row.tool_name),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    expiresAt: row.expires_at,
    status: 'approved',
  };
}

export async function consumeToolApproval(
  approvalId: string,
  context: { tenantId: string; applicationId: string; actorId: string },
  toolName: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE ai_tool_approvals SET status='consumed'
     WHERE id=$1 AND tenant_id=$2 AND application_id=$3 AND actor_id=$4 AND tool_name=$5
       AND status='approved' AND expires_at>NOW()
     RETURNING id`,
    [approvalId, context.tenantId, context.applicationId, context.actorId, toolName],
  );
  return Boolean(row);
}

export async function resolveActiveVectorIndex(
  tenantId: string,
  knowledgeBaseId: string,
): Promise<ActiveVectorIndex | null> {
  const row = await queryOne<{
    backend: string;
    collection_name: string;
    embedding_model: string;
    embedding_dimension: number;
    distance_metric: string;
  }>(
    `SELECT vi.backend,vi.collection_name,vi.embedding_model,vi.embedding_dimension,vi.distance_metric
     FROM ai_knowledge_base_bindings binding
     JOIN ai_vector_indexes vi
       ON vi.tenant_id=binding.tenant_id
      AND vi.knowledge_base_id=binding.knowledge_base_id
      AND vi.status='active'
     WHERE binding.tenant_id=$1 AND binding.knowledge_base_id=$2`,
    [tenantId, knowledgeBaseId],
  );
  if (!row) return null;
  return {
    backend: row.backend === 'pgvector' ? 'pgvector' : 'milvus',
    collectionName: String(row.collection_name),
    embeddingModel: String(row.embedding_model),
    embeddingDimension: Number(row.embedding_dimension),
    distanceMetric: String(row.distance_metric),
  };
}

export async function startAgentRun(options: {
  tenantId: string;
  applicationId: string;
  conversationId: string;
  threadId: string;
  graphName: string;
  graphVersion: string;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO ai_agent_runs
       (tenant_id,application_id,conversation_id,thread_id,graph_name,graph_version,status)
     VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`,
    [
      options.tenantId,
      options.applicationId,
      options.conversationId,
      options.threadId,
      options.graphName,
      options.graphVersion,
    ],
  );
  return String(row!.id);
}

export async function finishAgentRun(
  runId: string,
  status: 'interrupted' | 'completed' | 'failed',
  errorCode: string | null = null,
): Promise<void> {
  if (!['interrupted', 'completed', 'failed'].includes(status)) throw new Error('Agent 运行状态无效');
  await execute('UPDATE ai_agent_runs SET status=$2,completed_at=NOW(),error_code=$3 WHERE id=$1', [
    runId,
    status,
    errorCode,
  ]);
}

/** P3 治理：把 traceId、模型路由、用量、Skill 版本与估算成本回写到 Agent 运行记录。 */
export async function updateAgentRunTrace(
  runId: string,
  options: {
    traceId?: string | null;
    intent?: string | null;
    modelRoutes?: unknown[] | null;
    modelUsage?: unknown[] | null;
    skillVersions?: unknown[] | null;
    toolCallCount?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCostCny?: string | number | null;
  },
): Promise<void> {
  await execute(
    `UPDATE ai_agent_runs SET trace_id=COALESCE($2,trace_id),intent=COALESCE($3,intent),
            model_routes=COALESCE($4::jsonb,model_routes),model_usage=COALESCE($5::jsonb,model_usage),
            skill_versions=COALESCE($6::jsonb,skill_versions),tool_call_count=COALESCE($7,tool_call_count),
            input_tokens=COALESCE($8,input_tokens),output_tokens=COALESCE($9,output_tokens),
            estimated_cost_cny=COALESCE($10,estimated_cost_cny)
     WHERE id=$1`,
    [
      runId,
      options.traceId ?? null,
      options.intent ?? null,
      options.modelRoutes ? JSON.stringify(options.modelRoutes) : null,
      options.modelUsage ? JSON.stringify(options.modelUsage) : null,
      options.skillVersions ? JSON.stringify(options.skillVersions) : null,
      options.toolCallCount !== null && options.toolCallCount !== undefined
        ? Math.max(Math.trunc(options.toolCallCount), 0)
        : null,
      options.inputTokens !== null && options.inputTokens !== undefined
        ? Math.max(Math.trunc(options.inputTokens), 0)
        : null,
      options.outputTokens !== null && options.outputTokens !== undefined
        ? Math.max(Math.trunc(options.outputTokens), 0)
        : null,
      options.estimatedCostCny ?? null,
    ],
  );
}
