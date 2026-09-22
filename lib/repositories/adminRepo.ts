/**
 * 运营台数据访问：推荐问题管理、审计日志与审计 outbox。
 * outbox 用 CTE + FOR UPDATE SKIP LOCKED 抢占，保证多 worker 并发消费不重复。
 */
import { execute, query, queryOne, toJsonObject } from '../db/pool';
import type { SuggestedQuestion } from './conversations';

export interface SuggestedQuestionInput {
  content: string;
  regions: string[];
  budgetRanges: string[];
  partySizes: string[];
  sortOrder: number;
  enabled: boolean;
}

export interface AuditLogRecord {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  status: string;
  durationMs: number | null;
  createdAt: string | null;
}

interface QuestionRow {
  id: string;
  content: string;
  regions: string[];
  budget_ranges: string[];
  party_sizes: string[];
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function toQuestion(row: QuestionRow): SuggestedQuestion {
  return {
    id: String(row.id),
    content: row.content,
    regions: (row.regions ?? []).map(String),
    budgetRanges: (row.budget_ranges ?? []).map(String),
    partySizes: (row.party_sizes ?? []).map(String),
    sortOrder: Number(row.sort_order),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const QUESTION_COLUMNS = 'id,content,regions,budget_ranges,party_sizes,sort_order,enabled,created_at,updated_at';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function listAdminSuggestedQuestions(
  limit: number,
  offset: number,
  enabled?: boolean | null,
): Promise<SuggestedQuestion[]> {
  const rows = await query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM travel_suggested_questions
     WHERE ($3::boolean IS NULL OR enabled=$3) ORDER BY sort_order,id LIMIT $1 OFFSET $2`,
    [clamp(limit, 1, 100), Math.max(offset, 0), enabled ?? null],
  );
  return rows.map(toQuestion);
}

export async function createSuggestedQuestion(
  payload: SuggestedQuestionInput,
  actorId: string,
): Promise<SuggestedQuestion> {
  const row = await queryOne<QuestionRow>(
    `INSERT INTO travel_suggested_questions (content,regions,budget_ranges,party_sizes,sort_order,enabled,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${QUESTION_COLUMNS}`,
    [
      payload.content,
      payload.regions,
      payload.budgetRanges,
      payload.partySizes,
      payload.sortOrder,
      payload.enabled,
      actorId,
    ],
  );
  return toQuestion(row!);
}

export async function updateSuggestedQuestion(
  questionId: string,
  payload: SuggestedQuestionInput,
): Promise<SuggestedQuestion | null> {
  const row = await queryOne<QuestionRow>(
    `UPDATE travel_suggested_questions SET content=$2,regions=$3,budget_ranges=$4,party_sizes=$5,sort_order=$6,enabled=$7
     WHERE id=$1 RETURNING ${QUESTION_COLUMNS}`,
    [
      questionId,
      payload.content,
      payload.regions,
      payload.budgetRanges,
      payload.partySizes,
      payload.sortOrder,
      payload.enabled,
    ],
  );
  return row ? toQuestion(row) : null;
}

export async function deleteSuggestedQuestion(questionId: string): Promise<boolean> {
  const affected = await execute('DELETE FROM travel_suggested_questions WHERE id=$1', [questionId]);
  return affected === 1;
}

export async function audit(options: {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  status: string;
  durationMs: number | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await execute(
    `INSERT INTO travel_admin_audit_logs (actor_id,action,target_type,target_id,status,duration_ms,details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      options.actorId,
      options.action,
      options.targetType,
      options.targetId,
      options.status,
      options.durationMs,
      JSON.stringify(options.details ?? {}),
    ],
  );
}

export type AuditOutboxMethod = 'audit' | 'record_tool_call';

export async function enqueueAuditOutbox(
  method: AuditOutboxMethod,
  payload: Record<string, unknown>,
  maxAttempts = 5,
): Promise<string> {
  if (method !== 'audit' && method !== 'record_tool_call') {
    throw new Error('不支持的审计 outbox 事件类型');
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts)
     VALUES ($1,$2::jsonb,$3) RETURNING id`,
    [method, JSON.stringify(payload), clamp(Math.trunc(maxAttempts), 1, 20)],
  );
  return String(row!.id);
}

export interface ClaimedAuditEvent {
  id: string;
  method: AuditOutboxMethod;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
}

export async function claimAuditOutbox(limit = 50): Promise<ClaimedAuditEvent[]> {
  const rows = await query<{
    id: string;
    event_method: AuditOutboxMethod;
    payload: unknown;
    attempt_count: number;
    max_attempts: number;
  }>(
    `WITH candidates AS (
       SELECT id FROM travel_audit_outbox
       WHERE (status='pending' AND next_attempt_at<=NOW())
          OR (status='processing' AND locked_at<NOW()-INTERVAL '5 minutes')
       ORDER BY next_attempt_at,id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE travel_audit_outbox item
     SET status='processing',attempt_count=item.attempt_count+1,locked_at=NOW(),updated_at=NOW()
     FROM candidates WHERE item.id=candidates.id
     RETURNING item.id,item.event_method,item.payload,item.attempt_count,item.max_attempts`,
    [clamp(Math.trunc(limit), 1, 500)],
  );
  return rows.map((row) => ({
    id: String(row.id),
    method: row.event_method,
    payload: toJsonObject(row.payload),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
  }));
}

export async function completeAuditOutbox(eventId: string): Promise<void> {
  await execute(
    `UPDATE travel_audit_outbox SET status='completed',completed_at=NOW(),locked_at=NULL,updated_at=NOW()
     WHERE id=$1 AND status='processing'`,
    [eventId],
  );
}

export async function failAuditOutbox(
  eventId: string,
  error: string,
  nextAttemptAt: Date,
): Promise<string | null> {
  const value = await queryOne<{ status: string }>(
    `UPDATE travel_audit_outbox SET
       status=CASE WHEN attempt_count>=max_attempts THEN 'dead_letter' ELSE 'pending' END,
       next_attempt_at=CASE WHEN attempt_count>=max_attempts THEN next_attempt_at ELSE $3 END,
       last_error=$2,locked_at=NULL,updated_at=NOW()
     WHERE id=$1 AND status='processing' RETURNING status`,
    [eventId, String(error).slice(0, 160), nextAttemptAt],
  );
  return value ? value.status : null;
}

export async function listAuditLogs(limit: number, offset: number): Promise<AuditLogRecord[]> {
  const rows = await query<{
    id: string;
    actor_id: string | null;
    action: string;
    target_type: string;
    target_id: string | null;
    status: string;
    duration_ms: number | null;
    created_at: string;
  }>(
    `SELECT id,actor_id,action,target_type,target_id,status,duration_ms,created_at
     FROM travel_admin_audit_logs ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
    [clamp(limit, 1, 100), Math.max(offset, 0)],
  );
  return rows.map((row) => ({
    id: String(row.id),
    actorId: row.actor_id ? String(row.actor_id) : null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }));
}
