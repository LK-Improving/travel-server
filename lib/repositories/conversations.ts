/**
 * 会话、消息、偏好、反馈与收藏的数据访问。
 * 对应 Python 版 repositories/postgres.py 中的会话与用户域方法。
 */
import { execute, query, queryOne, toJsonList, transaction } from '../db/pool';
import { verifyPassword, hashPassword } from '../auth/passwords';
import type { Subject } from '../auth/subject';

export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationRecord {
  conversationId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  projectVersionId?: string | null;
}

export interface MessageRecord {
  id: string;
  role: string;
  content: string;
  sources: unknown[];
  toolCalls: unknown[];
  createdAt: string | null;
}

export interface FeatureFlagSet {
  chatEnabled: boolean;
  anonymousChatEnabled: boolean;
  newConversationEnabled: boolean;
  conversationHistoryEnabled: boolean;
  messageFeedbackEnabled: boolean;
  conversationFavoriteEnabled: boolean;
  sourceReferencesEnabled: boolean;
  suggestedQuestionsEnabled: boolean;
}

export interface ProjectConversationContext extends ConversationRecord {
  projectId: string;
  internalProjectId: string;
  projectVersionId: string;
  tenantId: string;
  systemPrompt: string;
  modelKey: string;
  temperature: number;
  maxTokens: number;
  featureFlags: Record<string, unknown>;
  knowledgeBaseIds: string[];
}

/** 匿名 client 首次出现时落库，后续请求刷新 last_seen_at。 */
async function clientUuid(clientKey: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO travel_clients (client_key,last_seen_at) VALUES ($1,NOW())
     ON CONFLICT (client_key) DO UPDATE SET last_seen_at=NOW() RETURNING id`,
    [clientKey],
  );
  return String(row?.id ?? '');
}

type OwnerColumn = 'owner_user_id' | 'owner_client_id';

async function owner(subject: Subject): Promise<[OwnerColumn, string]> {
  if (subject.kind === 'user') return ['owner_user_id', subject.id];
  return ['owner_client_id', await clientUuid(subject.id)];
}

/** 反馈表的所有者列与会话表命名不同（无 owner_ 前缀），单独成类型避免串用。 */
type FeedbackOwnerColumn = 'user_id' | 'client_id';

const FEEDBACK_COLUMN: Record<Subject['kind'], FeedbackOwnerColumn> = {
  user: 'user_id',
  client: 'client_id',
};

export async function authenticateUser(account: string, password: string): Promise<AuthUser | null> {
  const row = await queryOne<{
    id: string;
    email: string;
    username: string | null;
    password_hash: string;
    nickname: string | null;
    avatar_url: string | null;
    role: string;
    status: string;
    last_login_at: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    `SELECT id,email,username,password_hash,nickname,avatar_url,role,status,last_login_at,created_at,updated_at
     FROM travel_users WHERE (email=$1 OR username=$1) AND status='active'`,
    [account.trim().toLowerCase()],
  );
  if (!row) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;

  await execute('UPDATE travel_users SET last_login_at=NOW() WHERE id=$1', [row.id]);
  return {
    id: String(row.id),
    email: row.email,
    username: row.username,
    nickname: row.nickname || row.username || row.email,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createConversation(subject: Subject, title: string): Promise<ConversationRecord> {
  const [column, ownerId] = await owner(subject);
  const row = await queryOne<{ id: string; title: string; created_at: string; updated_at: string }>(
    `INSERT INTO travel_conversations (${column},title) VALUES ($1,$2) RETURNING id,title,created_at,updated_at`,
    [ownerId, title],
  );
  return {
    conversationId: String(row!.id),
    title: row!.title,
    createdAt: row!.created_at,
    updatedAt: row!.updated_at,
  };
}

/** 创建项目会话时把当前发布版本的内部 ID 写入快照，后续检索以该冻结版本执行。 */
export async function createProjectConversation(
  subject: Subject,
  projectId: string,
  projectVersionId: string,
  title: string,
): Promise<ConversationRecord> {
  const [column, ownerId] = await owner(subject);
  const row = await queryOne<{
    id: string;
    title: string;
    project_version_id: string;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO travel_conversations (${column},title,project_id,project_version_id)
     SELECT $1,$2,app.id,version.id
     FROM ai_applications app JOIN ai_project_versions version ON version.project_id=app.id
     WHERE app.id=$3 AND app.status='active' AND version.id=$4 AND version.status='published'
     RETURNING id,title,project_version_id,created_at,updated_at`,
    [ownerId, title, projectId, projectVersionId],
  );
  if (!row) throw new Error('项目已停用或发布版本已变更');
  return {
    conversationId: String(row.id),
    title: row.title,
    projectVersionId: String(row.project_version_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listConversations(
  subject: Subject,
  limit: number,
  offset: number,
): Promise<ConversationRecord[]> {
  const [column, ownerId] = await owner(subject);
  const rows = await query<{ id: string; title: string; created_at: string; updated_at: string }>(
    `SELECT id,title,created_at,updated_at FROM travel_conversations
     WHERE ${column}=$1 AND status='active' ORDER BY updated_at DESC,id DESC LIMIT $2 OFFSET $3`,
    [ownerId, limit, offset],
  );
  return rows.map((row) => ({
    conversationId: String(row.id),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listProjectConversations(
  subject: Subject,
  projectId: string,
  limit: number,
  offset: number,
): Promise<ConversationRecord[]> {
  const [column, ownerId] = await owner(subject);
  const rows = await query<{
    id: string;
    title: string;
    project_version_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id,title,project_version_id,created_at,updated_at
     FROM travel_conversations
     WHERE ${column}=$1 AND project_id=$2 AND status='active'
     ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [ownerId, projectId, limit, offset],
  );
  return rows.map((row) => ({
    conversationId: String(row.id),
    title: row.title,
    projectVersionId: row.project_version_id ? String(row.project_version_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getConversation(subject: Subject, conversationId: string): Promise<ConversationRecord | null> {
  const [column, ownerId] = await owner(subject);
  const row = await queryOne<{ id: string; title: string; created_at: string; updated_at: string }>(
    `SELECT id,title,created_at,updated_at FROM travel_conversations
     WHERE id=$1 AND ${column}=$2 AND status='active'`,
    [conversationId, ownerId],
  );
  if (!row) return null;
  return {
    conversationId: String(row.id),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 取会话并同时解析冻结版本的提示词、模型、开关与知识库，供项目会话聊天使用。 */
export async function getProjectConversation(
  subject: Subject,
  publicId: string,
  conversationId: string,
): Promise<ProjectConversationContext | null> {
  const [column, ownerId] = await owner(subject);
  const row = await queryOne<{
    conversation_id: string;
    title: string;
    created_at: string;
    updated_at: string;
    project_id: string;
    public_id: string;
    tenant_id: string;
    version_id: string;
    system_prompt: string;
    model_key: string;
    temperature: string;
    max_tokens: number;
    feature_flags: unknown;
    knowledge_base_ids: string[];
  }>(
    `SELECT conversation.id AS conversation_id,conversation.title,conversation.created_at,conversation.updated_at,
            app.id AS project_id,app.public_id,app.tenant_id,version.id AS version_id,
            version.system_prompt,version.model_key,version.temperature,version.max_tokens,version.feature_flags,
            COALESCE(array_agg(link.knowledge_base_id) FILTER (WHERE link.knowledge_base_id IS NOT NULL), ARRAY[]::uuid[]) AS knowledge_base_ids
     FROM travel_conversations conversation
     JOIN ai_applications app ON app.id=conversation.project_id AND app.status='active'
     JOIN ai_project_versions version
       ON version.id=conversation.project_version_id AND version.project_id=conversation.project_id
     LEFT JOIN ai_project_version_knowledge_bases link
       ON link.project_version_id=version.id AND link.project_id=app.id AND link.tenant_id=app.tenant_id
     WHERE conversation.id=$1 AND conversation.${column}=$2 AND conversation.status='active' AND app.public_id=$3
     GROUP BY conversation.id,app.id,version.id`,
    [conversationId, ownerId, publicId],
  );
  if (!row) return null;
  return {
    conversationId: String(row.conversation_id),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectId: String(row.public_id),
    internalProjectId: String(row.project_id),
    projectVersionId: String(row.version_id),
    tenantId: String(row.tenant_id),
    systemPrompt: String(row.system_prompt),
    modelKey: String(row.model_key),
    temperature: Number(row.temperature),
    maxTokens: Number(row.max_tokens),
    featureFlags: (row.feature_flags as Record<string, unknown>) ?? {},
    knowledgeBaseIds: (row.knowledge_base_ids ?? []).map(String),
  };
}

export async function listMessages(conversationId: string, limit: number, offset: number): Promise<MessageRecord[]> {
  const rows = await query<{
    id: string;
    role: string;
    content: string;
    sources: unknown;
    tool_calls: unknown;
    created_at: string;
  }>(
    `SELECT id,role,content,sources,tool_calls,created_at FROM travel_conversation_messages
     WHERE conversation_id=$1 AND delivery_status='complete' ORDER BY created_at,id LIMIT $2 OFFSET $3`,
    [conversationId, limit, offset],
  );
  return rows.map((row) => ({
    id: String(row.id),
    role: row.role,
    content: row.content,
    sources: toJsonList(row.sources),
    toolCalls: toJsonList(row.tool_calls),
    createdAt: row.created_at,
  }));
}

export async function deleteConversation(subject: Subject, conversationId: string): Promise<boolean> {
  const [column, ownerId] = await owner(subject);
  const affected = await execute(`DELETE FROM travel_conversations WHERE id=$1 AND ${column}=$2`, [
    conversationId,
    ownerId,
  ]);
  return affected === 1;
}

export async function deleteProjectConversation(
  subject: Subject,
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  const [column, ownerId] = await owner(subject);
  const affected = await execute(`DELETE FROM travel_conversations WHERE id=$1 AND ${column}=$2 AND project_id=$3`, [
    conversationId,
    ownerId,
    projectId,
  ]);
  return affected === 1;
}

/** 定位一条归属当前主体的、已完成的助手消息；不存在的越权目标统一表现为找不到。 */
export async function getProjectAssistantMessage(
  subject: Subject,
  publicId: string,
  messageId: string,
): Promise<{ messageId: string; conversationId: string; featureFlags: Record<string, unknown> } | null> {
  const [column, ownerId] = await owner(subject);
  const row = await queryOne<{ message_id: string; conversation_id: string; feature_flags: unknown }>(
    `SELECT message.id AS message_id,conversation.id AS conversation_id,version.feature_flags
     FROM travel_conversation_messages message
     JOIN travel_conversations conversation ON conversation.id=message.conversation_id
     JOIN ai_applications app ON app.id=conversation.project_id AND app.status='active'
     JOIN ai_project_versions version
       ON version.id=conversation.project_version_id AND version.project_id=conversation.project_id
     WHERE message.id=$1 AND message.role='assistant' AND message.delivery_status='complete'
       AND conversation.status='active' AND conversation.${column}=$2 AND app.public_id=$3`,
    [messageId, ownerId, publicId],
  );
  if (!row) return null;
  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    featureFlags: (row.feature_flags as Record<string, unknown>) ?? {},
  };
}

export async function upsertProjectMessageFeedback(
  subject: Subject,
  messageId: string,
  value: string,
): Promise<{ messageId: string; value: string }> {
  const column = FEEDBACK_COLUMN[subject.kind];
  const row = await queryOne<{ message_id: string; value: string }>(
    `INSERT INTO ai_message_feedback (message_id,${column},value)
     VALUES ($1,$2,$3)
     ON CONFLICT (message_id,${column}) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
     RETURNING message_id,value`,
    [messageId, subject.id, value],
  );
  return { messageId: String(row!.message_id), value: row!.value };
}

export async function deleteProjectMessageFeedback(subject: Subject, messageId: string): Promise<boolean> {
  const column = FEEDBACK_COLUMN[subject.kind];
  await execute(`DELETE FROM ai_message_feedback WHERE message_id=$1 AND ${column}=$2`, [messageId, subject.id]);
  return true;
}

/**
 * 收藏会话。标题与元数据一律从可信会话记录生成，不接受客户端提交的目标或元数据。
 * 重复收藏是幂等的 upsert。
 */
export async function favoriteProjectConversation(
  subject: Subject,
  publicId: string,
  conversationId: string,
): Promise<{ conversationId: string; favorited: boolean } | null> {
  const row = await queryOne<{ target_id: string }>(
    `INSERT INTO travel_favorites (user_id,target_type,target_id,title,metadata)
     SELECT $1,'conversation',conversation.id::text,conversation.title,
            jsonb_build_object('projectId', app.public_id)
     FROM travel_conversations conversation
     JOIN ai_applications app ON app.id=conversation.project_id AND app.status='active'
     WHERE conversation.id=$2 AND conversation.owner_user_id=$1
       AND conversation.status='active' AND app.public_id=$3
     ON CONFLICT (user_id,target_type,target_id) WHERE target_id IS NOT NULL
     DO UPDATE SET title=EXCLUDED.title,metadata=EXCLUDED.metadata,updated_at=NOW()
     RETURNING target_id`,
    [subject.id, conversationId, publicId],
  );
  return row ? { conversationId: String(row.target_id), favorited: true } : null;
}

export async function unfavoriteProjectConversation(
  subject: Subject,
  publicId: string,
  conversationId: string,
): Promise<boolean> {
  await execute(
    `DELETE FROM travel_favorites favorite
     USING travel_conversations conversation
     JOIN ai_applications app ON app.id=conversation.project_id AND app.status='active'
     WHERE favorite.user_id=$1 AND favorite.target_type='conversation' AND favorite.target_id=conversation.id::text
       AND conversation.id=$2 AND conversation.owner_user_id=$1 AND conversation.status='active' AND app.public_id=$3`,
    [subject.id, conversationId, publicId],
  );
  return true;
}

export interface UserPreferences {
  regions: string[];
  budgetRange: string | null;
  partySize: string | null;
}

export async function getPreferences(subject: Subject): Promise<UserPreferences | null> {
  const row = await queryOne<{ regions: string[]; budget_range: string | null; party_size: string | null }>(
    'SELECT regions,budget_range,party_size FROM travel_user_preferences WHERE owner_key=$1',
    [subject.key],
  );
  if (!row) return null;
  return {
    regions: (row.regions ?? []).map(String),
    budgetRange: row.budget_range,
    partySize: row.party_size,
  };
}

export async function savePreferences(
  subject: Subject,
  preferences: UserPreferences,
): Promise<UserPreferences> {
  const row = await queryOne<{ regions: string[]; budget_range: string | null; party_size: string | null }>(
    `INSERT INTO travel_user_preferences (owner_key,owner_type,owner_id,regions,budget_range,party_size)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_key) DO UPDATE SET regions=EXCLUDED.regions,budget_range=EXCLUDED.budget_range,
       party_size=EXCLUDED.party_size,updated_at=NOW()
     RETURNING regions,budget_range,party_size`,
    [
      subject.key,
      subject.kind,
      subject.id,
      preferences.regions,
      preferences.budgetRange,
      preferences.partySize,
    ],
  );
  return {
    regions: (row!.regions ?? []).map(String),
    budgetRange: row!.budget_range,
    partySize: row!.party_size,
  };
}

export async function deletePreferences(subject: Subject): Promise<void> {
  await execute('DELETE FROM travel_user_preferences WHERE owner_key=$1', [subject.key]);
}

export interface SuggestedQuestion {
  id: string;
  content: string;
  regions: string[];
  budgetRanges: string[];
  partySizes: string[];
  sortOrder: number;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function listSuggestedQuestions(): Promise<SuggestedQuestion[]> {
  const rows = await query<{
    id: string;
    content: string;
    regions: string[];
    budget_ranges: string[];
    party_sizes: string[];
    sort_order: number;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id,content,regions,budget_ranges,party_sizes,sort_order,enabled,created_at,updated_at
     FROM travel_suggested_questions ORDER BY sort_order,id`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    content: row.content,
    regions: (row.regions ?? []).map(String),
    budgetRanges: (row.budget_ranges ?? []).map(String),
    partySizes: (row.party_sizes ?? []).map(String),
    sortOrder: row.sort_order,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function saveUserMessage(conversationId: string, content: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    "INSERT INTO travel_conversation_messages (conversation_id,role,content) VALUES ($1,'user',$2) RETURNING id",
    [conversationId, content],
  );
  return String(row!.id);
}

export async function startAssistantMessage(conversationId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO travel_conversation_messages (conversation_id,role,content,delivery_status)
     VALUES ($1,'assistant','','processing') RETURNING id`,
    [conversationId],
  );
  return String(row!.id);
}

export async function finishAssistantMessage(
  messageId: string,
  options: { content: string; sources: unknown[]; toolCalls: unknown[]; status: string },
): Promise<void> {
  await execute(
    `UPDATE travel_conversation_messages SET content=$2,sources=$3::jsonb,tool_calls=$4::jsonb,delivery_status=$5
     WHERE id=$1`,
    [
      messageId,
      options.content,
      JSON.stringify(options.sources),
      JSON.stringify(options.toolCalls),
      options.status,
    ],
  );
}

export async function recentConversationMessages(
  conversationId: string,
  limit: number,
): Promise<Array<{ role: string; content: string }>> {
  const rows = await query<{ role: string; content: string }>(
    `SELECT role,content FROM (
       SELECT id,role,content,created_at FROM travel_conversation_messages
       WHERE conversation_id=$1 AND delivery_status='complete' ORDER BY created_at DESC,id DESC LIMIT $2
     ) recent ORDER BY created_at,id`,
    [conversationId, limit],
  );
  return rows.map((row) => ({ role: row.role, content: row.content }));
}

export async function getConversationSummary(conversationId: string): Promise<string> {
  const value = await queryOne<{ summary: string }>(
    'SELECT summary FROM travel_conversation_summaries WHERE conversation_id=$1',
    [conversationId],
  );
  return String(value?.summary ?? '');
}

export async function updateConversationSummary(
  conversationId: string,
  summary: string,
  messageCount: number,
  options: {
    summaryEmbedding?: number[] | null;
    embeddingModel?: string | null;
    lastCompactedMessageId?: string | null;
  } = {},
): Promise<void> {
  await execute(
    `INSERT INTO travel_conversation_summaries
       (conversation_id,summary,message_count,summary_embedding,embedding_model,last_compacted_message_id)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (conversation_id) DO UPDATE SET
       summary=EXCLUDED.summary,message_count=EXCLUDED.message_count,
       summary_embedding=EXCLUDED.summary_embedding,embedding_model=EXCLUDED.embedding_model,
       last_compacted_message_id=EXCLUDED.last_compacted_message_id,updated_at=NOW()`,
    [
      conversationId,
      summary,
      Math.max(messageCount, 0),
      JSON.stringify(options.summaryEmbedding ?? []),
      options.embeddingModel ?? null,
      options.lastCompactedMessageId ?? null,
    ],
  );
}

/** 记录一次工具调用，供审计与评测取证。 */
export async function recordToolCall(options: {
  conversationId: string | null;
  actorKey: string | null;
  toolName: string;
  argumentsSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  status: string;
  durationMs: number;
  errorMessage: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO travel_tool_calls (conversation_id,actor_key,tool_name,arguments_summary,result_summary,status,duration_ms,error_message)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
    [
      options.conversationId,
      options.actorKey,
      options.toolName,
      JSON.stringify(options.argumentsSummary),
      JSON.stringify(options.resultSummary),
      options.status,
      options.durationMs,
      options.errorMessage,
    ],
  );
}

export interface CreateUserOptions {
  account: string;
  password: string;
  email?: string;
  nickname?: string;
  role?: string;
}

/** 注册新用户（travel_users 表，与 Node 旧版账户体系兼容）。 */
export async function createUser(options: CreateUserOptions): Promise<AuthUser> {
  const account = options.account.trim().toLowerCase();
  if (!account) throw new Error('账号不能为空');
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM travel_users WHERE email=$1 OR username=$1`,
    [account],
  );
  if (existing) throw new Error('账号已存在');
  const hash = await hashPassword(options.password);
  const role = (options.role ?? 'user').trim().toLowerCase();
  const row = await queryOne<{
    id: string;
    email: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
    role: string;
    status: string;
    last_login_at: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(
    `INSERT INTO travel_users (email,username,password_hash,nickname,role,status)
     VALUES ($1,$2,$3,$4,$5,'active')
     RETURNING id,email,username,nickname,avatar_url,role,status,last_login_at,created_at,updated_at`,
    [account, options.account.trim(), hash, (options.nickname ?? options.account).trim(), role],
  );
  if (!row) throw new Error('注册失败');
  return {
    id: String(row.id),
    email: row.email,
    username: row.username,
    nickname: row.nickname || row.username || row.email,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { transaction };
