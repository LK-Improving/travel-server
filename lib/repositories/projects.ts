/**
 * 多租户项目与版本管理。
 * 对应 Python 版 repositories/postgres.py 的项目域方法。
 * 发布会把旧版本归档并把冻结配置写入会话快照，客户端不得提交内部版本 ID。
 */
import { execute, executeMany, query, queryOne, toJsonList, toJsonObject, transaction } from '../db/pool';
import { DomainConflictError } from '../errors';

export interface ProjectVersionRecord {
  projectId: string;
  versionId: string;
  publicId: string;
  name: string;
  description: string;
  logoUrl: string | null;
  themeColor: string;
  welcomeMessage: string;
  inputPlaceholder: string;
  suggestedQuestions: string[];
  systemPrompt: string;
  modelKey: string;
  temperature: number;
  maxTokens: number;
  featureFlags: Record<string, unknown>;
  status: string;
  knowledgeBaseIds?: string[];
  projectStatus?: string;
}

export interface ProjectSummary {
  projectId: string;
  publicId: string;
  name: string;
  status: string;
  tenantId?: string;
  membershipRole?: string | null;
}

export interface PublishedProjectRuntime {
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

interface VersionRow {
  version_id: string;
  project_id: string;
  public_id: string;
  status: string;
  display_config: unknown;
  system_prompt: string;
  model_key: string;
  temperature: string | number;
  max_tokens: number;
  feature_flags: unknown;
  project_status?: string;
  knowledge_base_ids?: string[];
}

const DISPLAY_KEYS = [
  'name',
  'description',
  'logoUrl',
  'themeColor',
  'welcomeMessage',
  'inputPlaceholder',
  'suggestedQuestions',
] as const;

export interface ProjectDraftPayload {
  name?: string;
  description?: string;
  logoUrl?: string | null;
  themeColor?: string;
  welcomeMessage?: string;
  inputPlaceholder?: string;
  suggestedQuestions?: string[];
  systemPrompt: string;
  modelKey: string;
  temperature: number;
  maxTokens: number;
  featureFlags: Record<string, unknown>;
  publicId?: string;
  knowledgeBaseIds?: string[];
}

function displayConfig(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of DISPLAY_KEYS) {
    result[key] = payload[key] ?? null;
  }
  return result;
}

function toProjectVersion(row: VersionRow): ProjectVersionRecord {
  const display = toJsonObject(row.display_config);
  const record: ProjectVersionRecord = {
    projectId: String(row.project_id),
    versionId: String(row.version_id),
    publicId: String(row.public_id),
    name: String(display.name ?? ''),
    description: String(display.description ?? ''),
    logoUrl: display.logoUrl ? String(display.logoUrl) : null,
    themeColor: String(display.themeColor ?? '#1677FF'),
    welcomeMessage: String(display.welcomeMessage ?? ''),
    inputPlaceholder: String(display.inputPlaceholder ?? ''),
    suggestedQuestions: Array.isArray(display.suggestedQuestions) ? display.suggestedQuestions.map(String) : [],
    systemPrompt: String(row.system_prompt),
    modelKey: String(row.model_key),
    temperature: Number(row.temperature),
    maxTokens: Number(row.max_tokens),
    featureFlags: toJsonObject(row.feature_flags),
    status: String(row.status),
  };
  if (row.project_status !== undefined) record.projectStatus = String(row.project_status);
  if (row.knowledge_base_ids) record.knowledgeBaseIds = row.knowledge_base_ids.map(String);
  return record;
}

const VERSION_COLUMNS_BARE = `version.id AS version_id,version.project_id,version.status,
  version.display_config,version.system_prompt,version.model_key,version.temperature,version.max_tokens,
  version.feature_flags`;

// 与 ai_applications 联表查询时额外带出 public_id。
const VERSION_COLUMNS = VERSION_COLUMNS_BARE.replace(
  'version.project_id,version.status',
  'version.project_id,app.public_id,version.status',
);

export async function listProjectCreationOptions(
  actorId: string,
): Promise<Array<{ tenantId: string; role: string; knowledgeBases: KnowledgeBaseOption[] }>> {
  const rows = await query<{
    tenant_id: string;
    role: string;
    knowledge_base_id: string | null;
    name: string | null;
    description: string | null;
    status: string | null;
    document_count: number | null;
  }>(
    `SELECT membership.tenant_id,membership.role,kb.id AS knowledge_base_id,kb.name,
            kb.description,kb.status,COUNT(document.id)::int AS document_count
     FROM ai_memberships membership
     LEFT JOIN ai_tenant_knowledge_bases tenant_kb ON tenant_kb.tenant_id=membership.tenant_id
     LEFT JOIN travel_knowledge_bases kb ON kb.id=tenant_kb.knowledge_base_id
     LEFT JOIN travel_documents document ON document.knowledge_base_id=kb.id
     WHERE membership.user_id=$1
     GROUP BY membership.tenant_id,membership.role,kb.id,kb.name,kb.description,kb.status
     ORDER BY membership.tenant_id,kb.name NULLS LAST`,
    [actorId],
  );

  const options = new Map<string, { tenantId: string; role: string; knowledgeBases: KnowledgeBaseOption[] }>();
  for (const row of rows) {
    const tenantId = String(row.tenant_id);
    const item = options.get(tenantId) ?? {
      tenantId,
      role: String(row.role),
      knowledgeBases: [] as KnowledgeBaseOption[],
    };
    if (row.knowledge_base_id !== null) {
      item.knowledgeBases.push({
        id: String(row.knowledge_base_id),
        name: String(row.name),
        description: String(row.description ?? ''),
        status: String(row.status),
        documentCount: Number(row.document_count ?? 0),
      });
    }
    options.set(tenantId, item);
  }
  return [...options.values()];
}

export interface KnowledgeBaseOption {
  id: string;
  name: string;
  description: string;
  status: string;
  documentCount: number;
}

export async function resolveProject(
  publicId: string,
): Promise<{ projectId: string; tenantId: string; publicId: string; status: string } | null> {
  const row = await queryOne<{ id: string; tenant_id: string; public_id: string; status: string }>(
    'SELECT id,tenant_id,public_id,status FROM ai_applications WHERE public_id=$1',
    [publicId],
  );
  if (!row) return null;
  return {
    projectId: String(row.id),
    tenantId: String(row.tenant_id),
    publicId: String(row.public_id),
    status: String(row.status),
  };
}

export async function listProjectsForActor(actorId: string, tenantId: string): Promise<ProjectSummary[]> {
  const rows = await query<{ project_id: string; public_id: string; name: string; status: string }>(
    `SELECT app.id AS project_id,app.public_id,app.name,app.status
     FROM ai_applications app JOIN ai_memberships membership ON membership.tenant_id=app.tenant_id
     WHERE membership.user_id=$1 AND app.tenant_id=$2 ORDER BY app.created_at DESC,app.id DESC`,
    [actorId, tenantId],
  );
  return rows.map((row) => ({
    projectId: String(row.project_id),
    publicId: String(row.public_id),
    name: row.name,
    status: row.status,
  }));
}

export async function createProject(
  actorId: string,
  tenantId: string,
  payload: ProjectDraftPayload & { publicId: string; name: string },
  knowledgeBaseIds: string[],
): Promise<ProjectVersionRecord> {
  return transaction(async (client) => {
    const allowed = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ai_memberships
        WHERE tenant_id=$1 AND user_id=$2 AND role IN ('operator','admin')) AS allowed`,
      [tenantId, actorId],
    );
    if (!allowed.rows[0]?.allowed) throw new Error('没有项目管理权限');

    const owned = await client.query(
      `SELECT knowledge_base_id FROM ai_tenant_knowledge_bases
       WHERE tenant_id=$1 AND knowledge_base_id=ANY($2::uuid[])`,
      [tenantId, knowledgeBaseIds],
    );
    const ownedSet = new Set(owned.rows.map((row: { knowledge_base_id: string }) => String(row.knowledge_base_id)));
    if (ownedSet.size !== new Set(knowledgeBaseIds).size || knowledgeBaseIds.some((id) => !ownedSet.has(id))) {
      throw new Error('知识库不存在或不属于当前租户');
    }

    const app = await client.query(
      `INSERT INTO ai_applications (tenant_id,app_key,public_id,name)
       SELECT $2,$3,$4,$5
       WHERE EXISTS (SELECT 1 FROM ai_memberships WHERE tenant_id=$2 AND user_id=$1 AND role IN ('operator','admin'))
       RETURNING id,public_id`,
      [actorId, tenantId, `project:${payload.publicId}`, payload.publicId, payload.name],
    );
    if (!app.rows[0]) throw new Error('没有项目管理权限');

    const version = await client.query<VersionRow>(
      `INSERT INTO ai_project_versions
         (project_id,version,status,display_config,system_prompt,model_key,temperature,max_tokens,feature_flags,created_by)
       VALUES ($1,1,'draft',$2::jsonb,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING ${VERSION_COLUMNS}`,
      [
        app.rows[0].id,
        JSON.stringify(displayConfig(payload as unknown as Record<string, unknown>)),
        payload.systemPrompt,
        payload.modelKey,
        payload.temperature,
        payload.maxTokens,
        JSON.stringify(payload.featureFlags ?? {}),
        actorId,
      ],
    );

    await executeMany(
      client,
      `INSERT INTO ai_project_version_knowledge_bases
         (project_version_id,knowledge_base_id,tenant_id,project_id) VALUES ($1,$2,$3,$4)`,
      knowledgeBaseIds.map((id) => [version.rows[0].version_id, id, tenantId, app.rows[0].id]),
    );

    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: 'project.create',
          target_type: 'project',
          target_id: String(app.rows[0].id),
          status: 'succeeded',
          duration_ms: 0,
          details: {
            tenantId,
            projectId: String(app.rows[0].id),
            versionId: String(version.rows[0].version_id),
            knowledgeBaseCount: knowledgeBaseIds.length,
          },
        }),
      ],
    );

    const record = toProjectVersion(version.rows[0]);
    record.knowledgeBaseIds = knowledgeBaseIds;
    return record;
  });
}

export async function getProjectForTenant(
  tenantId: string,
  publicId: string,
): Promise<{ projectId: string; publicId: string; status: string } | null> {
  const row = await queryOne<{ id: string; public_id: string; status: string }>(
    'SELECT id,public_id,status FROM ai_applications WHERE tenant_id=$1 AND public_id=$2',
    [tenantId, publicId],
  );
  return row ? { projectId: String(row.id), publicId: String(row.public_id), status: String(row.status) } : null;
}

export async function listProjectVersions(tenantId: string, projectId: string): Promise<ProjectVersionRecord[]> {
  const rows = await query<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
     FROM ai_project_versions version JOIN ai_applications app ON app.id=version.project_id
     WHERE app.tenant_id=$1 AND version.project_id=$2 ORDER BY version.version DESC`,
    [tenantId, projectId],
  );
  return rows.map(toProjectVersion);
}

export async function getProjectVersion(
  tenantId: string,
  projectId: string,
  versionId: string,
): Promise<ProjectVersionRecord | null> {
  const row = await queryOne<
    VersionRow & { knowledge_base_ids: string[]; project_status: string }
  >(
    `SELECT ${VERSION_COLUMNS},app.status AS project_status,
            COALESCE(array_agg(link.knowledge_base_id) FILTER (WHERE link.knowledge_base_id IS NOT NULL), ARRAY[]::uuid[]) AS knowledge_base_ids
     FROM ai_project_versions version JOIN ai_applications app ON app.id=version.project_id
     LEFT JOIN ai_project_version_knowledge_bases link ON link.project_version_id=version.id
     WHERE app.tenant_id=$1 AND version.project_id=$2 AND version.id=$3
     GROUP BY version.id,app.public_id,app.status`,
    [tenantId, projectId, versionId],
  );
  if (!row) return null;
  const record = toProjectVersion(row);
  record.knowledgeBaseIds = (row.knowledge_base_ids ?? []).map(String);
  record.projectStatus = String(row.project_status);
  return record;
}

/** 保存草稿配置与租户知识库绑定，两者在同一事务内完成。 */
export async function saveDraftWithKnowledgeBases(
  actorId: string,
  tenantId: string,
  projectId: string,
  versionId: string,
  payload: ProjectDraftPayload,
  knowledgeBaseIds: string[],
): Promise<ProjectVersionRecord | null> {
  return transaction(async (client) => {
    const allowed = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ai_memberships
        WHERE tenant_id=$1 AND user_id=$2 AND role IN ('operator','admin')) AS allowed`,
      [tenantId, actorId],
    );
    if (!allowed.rows[0]?.allowed) throw new Error('没有项目管理权限');

    const owned = await client.query(
      `SELECT knowledge_base_id FROM ai_tenant_knowledge_bases
       WHERE tenant_id=$1 AND knowledge_base_id=ANY($2::uuid[])`,
      [tenantId, knowledgeBaseIds],
    );
    const ownedSet = new Set(owned.rows.map((row: { knowledge_base_id: string }) => String(row.knowledge_base_id)));
    if (knowledgeBaseIds.some((id) => !ownedSet.has(id))) {
      throw new Error('知识库不存在或不属于当前租户');
    }

    const updated = await client.query<VersionRow>(
      `UPDATE ai_project_versions version SET display_config=$5::jsonb,system_prompt=$6,model_key=$7,
              temperature=$8,max_tokens=$9,feature_flags=$10::jsonb
       FROM ai_applications app
       WHERE version.id=$4 AND version.project_id=$3 AND version.status='draft' AND app.id=version.project_id
         AND app.tenant_id=$2 AND EXISTS (SELECT 1 FROM ai_memberships WHERE tenant_id=$2 AND user_id=$1 AND role IN ('operator','admin'))
       RETURNING ${VERSION_COLUMNS}`,
      [
        actorId,
        tenantId,
        projectId,
        versionId,
        JSON.stringify(displayConfig(payload as unknown as Record<string, unknown>)),
        payload.systemPrompt,
        payload.modelKey,
        payload.temperature,
        payload.maxTokens,
        JSON.stringify(payload.featureFlags ?? {}),
      ],
    );
    if (!updated.rows[0]) return null;

    await client.query(
      `DELETE FROM ai_project_version_knowledge_bases
       WHERE project_version_id=$1 AND project_id=$2 AND tenant_id=$3`,
      [versionId, projectId, tenantId],
    );
    await executeMany(
      client,
      `INSERT INTO ai_project_version_knowledge_bases (project_version_id,knowledge_base_id,tenant_id,project_id)
       VALUES ($1,$4,$2,$3)`,
      knowledgeBaseIds.map((id) => [versionId, tenantId, projectId, id]),
    );
    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: 'project.draft.save',
          target_type: 'project_version',
          target_id: versionId,
          status: 'succeeded',
          duration_ms: 0,
          details: { projectId },
        }),
      ],
    );

    const record = toProjectVersion(updated.rows[0]);
    record.knowledgeBaseIds = [...knowledgeBaseIds];
    return record;
  });
}

/** 从同一项目、同一租户的 published/archived 版本复制出新草稿；draft 与跨项目来源一律拒绝。 */
export async function createDraftFromVersion(
  actorId: string,
  tenantId: string,
  projectId: string,
  versionId: string,
): Promise<ProjectVersionRecord | null> {
  return transaction(async (client) => {
    const project = await client.query<{ public_id: string }>(
      `SELECT app.public_id FROM ai_applications app
       WHERE app.id=$3 AND app.tenant_id=$2
         AND EXISTS (SELECT 1 FROM ai_memberships WHERE tenant_id=$2 AND user_id=$1 AND role='admin')
       FOR UPDATE`,
      [actorId, tenantId, projectId],
    );
    if (!project.rows[0]) return null;

    const inserted = await client.query<VersionRow>(
      `INSERT INTO ai_project_versions
         (project_id,version,status,display_config,system_prompt,model_key,temperature,max_tokens,feature_flags,created_by)
       SELECT source.project_id,
              (SELECT COALESCE(MAX(version),0)+1 FROM ai_project_versions WHERE project_id=source.project_id),
              'draft',source.display_config,source.system_prompt,source.model_key,source.temperature,
              source.max_tokens,source.feature_flags,$1
       FROM ai_project_versions source
       WHERE source.id=$4 AND source.project_id=$3 AND source.status IN ('published','archived')
       RETURNING ${VERSION_COLUMNS_BARE}`,
      [actorId, tenantId, projectId, versionId],
    );
    if (!inserted.rows[0]) return null;

    const sourceKbs = await client.query<{ knowledge_base_id: string }>(
      `SELECT knowledge_base_id FROM ai_project_version_knowledge_bases
       WHERE project_version_id=$1 AND project_id=$2 AND tenant_id=$3`,
      [versionId, projectId, tenantId],
    );
    await executeMany(
      client,
      `INSERT INTO ai_project_version_knowledge_bases (project_version_id,knowledge_base_id,tenant_id,project_id)
       VALUES ($1,$4,$2,$3)`,
      sourceKbs.rows.map((row) => [inserted.rows[0].version_id, tenantId, projectId, row.knowledge_base_id]),
    );
    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: 'project.copy',
          target_type: 'project_version',
          target_id: String(inserted.rows[0].version_id),
          status: 'succeeded',
          duration_ms: 0,
          details: { sourceVersionId: versionId },
        }),
      ],
    );

    const record = toProjectVersion({ ...inserted.rows[0], public_id: project.rows[0].public_id });
    record.knowledgeBaseIds = sourceKbs.rows.map((row) => String(row.knowledge_base_id));
    return record;
  });
}

export interface TestRunRecord {
  testRunId: string;
  projectId: string;
  versionId: string;
  requestText: string;
  answerText: string;
  citedChunkIds: unknown[];
  elapsedMs: number;
  passed: boolean | null;
  createdAt: string | null;
}

export async function createTestRun(
  actorId: string,
  tenantId: string,
  projectId: string,
  versionId: string,
  payload: {
    requestText: string;
    answerText: string;
    citedChunkIds: string[];
    elapsedMs: number;
    passed: boolean | null;
  },
): Promise<TestRunRecord> {
  return transaction(async (client) => {
    const inserted = await client.query<{
      id: string;
      project_id: string;
      project_version_id: string;
      request_text: string;
      answer_text: string;
      cited_chunk_ids: unknown;
      elapsed_ms: number;
      passed: boolean | null;
      created_at: string;
    }>(
      `INSERT INTO ai_project_test_runs
         (project_id,project_version_id,request_text,answer_text,cited_chunk_ids,elapsed_ms,passed,created_by)
       SELECT $3,$4,$5,$6,$7::jsonb,$8,$9,$1
       WHERE EXISTS (
         SELECT 1 FROM ai_project_versions version JOIN ai_applications app ON app.id=version.project_id
         JOIN ai_memberships membership ON membership.tenant_id=app.tenant_id
         WHERE version.id=$4 AND version.project_id=$3 AND version.status='draft' AND app.tenant_id=$2
           AND app.status='active' AND membership.user_id=$1 AND membership.role IN ('operator','admin')
       )
       RETURNING id,project_id,project_version_id,request_text,answer_text,cited_chunk_ids,elapsed_ms,passed,created_at`,
      [
        actorId,
        tenantId,
        projectId,
        versionId,
        payload.requestText,
        payload.answerText,
        JSON.stringify(payload.citedChunkIds),
        payload.elapsedMs,
        payload.passed,
      ],
    );
    if (!inserted.rows[0]) throw new Error('没有项目测试权限');

    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: 'project.test',
          target_type: 'project_version',
          target_id: versionId,
          status: 'succeeded',
          duration_ms: payload.elapsedMs,
          details: { projectId },
        }),
      ],
    );

    const row = inserted.rows[0];
    return {
      testRunId: String(row.id),
      projectId: String(row.project_id),
      versionId: String(row.project_version_id),
      requestText: row.request_text,
      answerText: row.answer_text,
      citedChunkIds: toJsonList(row.cited_chunk_ids),
      elapsedMs: Number(row.elapsed_ms),
      passed: row.passed,
      createdAt: row.created_at,
    };
  });
}

export async function hasCompletedTestRun(
  tenantId: string,
  projectId: string,
  versionId: string,
): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_project_test_runs run JOIN ai_applications app ON app.id=run.project_id
       WHERE app.tenant_id=$1 AND run.project_id=$2 AND run.project_version_id=$3
     ) AS exists`,
    [tenantId, projectId, versionId],
  );
  return Boolean(row?.exists);
}

/** 发布：归档旧 published 版本并发布目标草稿，强制要求知识库与测试齐备。 */
export async function publishProjectVersion(
  actorId: string,
  tenantId: string,
  projectId: string,
  versionId: string,
): Promise<ProjectVersionRecord> {
  return transaction(async (client) => {
    const project = await client.query<{ public_id: string }>(
      `SELECT public_id FROM ai_applications app WHERE app.id=$3 AND app.tenant_id=$2 AND app.status='active'
         AND EXISTS (SELECT 1 FROM ai_memberships WHERE tenant_id=$2 AND user_id=$1 AND role='admin') FOR UPDATE`,
      [actorId, tenantId, projectId],
    );
    if (!project.rows[0]) throw new Error('没有项目发布权限');

    const version = await client.query<{ id: string; status: string }>(
      `SELECT id,project_id,status FROM ai_project_versions WHERE id=$2 AND project_id=$1 FOR UPDATE`,
      [projectId, versionId],
    );
    if (!version.rows[0]) throw new Error('项目版本不存在');
    if (version.rows[0].status !== 'draft') throw new DomainConflictError('仅草稿版本可以发布');

    const kbCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM ai_project_version_knowledge_bases
       WHERE project_version_id=$1 AND project_id=$2 AND tenant_id=$3`,
      [versionId, projectId, tenantId],
    );
    if (!Number(kbCount.rows[0]?.count ?? 0)) throw new Error('发布至少需要一个知识库');

    const tested = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ai_project_test_runs WHERE project_id=$1 AND project_version_id=$2) AS tested`,
      [projectId, versionId],
    );
    if (!tested.rows[0]?.tested) throw new Error('至少需要一次已完成测试');

    await client.query("UPDATE ai_project_versions SET status='archived' WHERE project_id=$1 AND status='published'", [
      projectId,
    ]);
    const published = await client.query<VersionRow>(
      `UPDATE ai_project_versions SET status='published',published_at=NOW() WHERE id=$1 AND project_id=$2
       RETURNING ${VERSION_COLUMNS}`,
      [versionId, projectId],
    );
    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: 'project.publish',
          target_type: 'project_version',
          target_id: versionId,
          status: 'succeeded',
          duration_ms: 0,
          details: { projectId },
        }),
      ],
    );
    const kbs = await client.query<{ knowledge_base_id: string }>(
      'SELECT knowledge_base_id FROM ai_project_version_knowledge_bases WHERE project_version_id=$1',
      [versionId],
    );

    const record = toProjectVersion(published.rows[0]);
    record.knowledgeBaseIds = kbs.rows.map((row) => String(row.knowledge_base_id));
    return record;
  });
}

export async function setProjectStatus(
  actorId: string,
  tenantId: string,
  projectId: string,
  status: 'active' | 'disabled',
): Promise<{ projectId: string; tenantId: string; publicId: string; status: string }> {
  if (!['active', 'disabled'].includes(status)) throw new Error('项目状态无效');
  return transaction(async (client) => {
    const updated = await client.query<{ id: string; tenant_id: string; public_id: string; status: string }>(
      `UPDATE ai_applications app SET status=$4 WHERE app.id=$3 AND app.tenant_id=$2
         AND EXISTS (SELECT 1 FROM ai_memberships WHERE tenant_id=$2 AND user_id=$1 AND role='admin')
       RETURNING id,tenant_id,public_id,status`,
      [actorId, tenantId, projectId, status],
    );
    if (!updated.rows[0]) throw new Error('没有项目管理权限');

    await client.query(
      `INSERT INTO travel_audit_outbox (event_method,payload,max_attempts) VALUES ('audit',$1::jsonb,5)`,
      [
        JSON.stringify({
          actor_id: actorId,
          action: status === 'active' ? 'project.reenable' : 'project.archive',
          target_type: 'project',
          target_id: projectId,
          status: 'succeeded',
          duration_ms: 0,
          details: {},
        }),
      ],
    );

    const row = updated.rows[0];
    return {
      projectId: String(row.id),
      tenantId: String(row.tenant_id),
      publicId: String(row.public_id),
      status: String(row.status),
    };
  });
}

export async function listTenantKnowledgeBases(
  tenantId: string,
  knowledgeBaseIds: string[],
): Promise<string[]> {
  const rows = await query<{ knowledge_base_id: string }>(
    `SELECT knowledge_base_id FROM ai_tenant_knowledge_bases
     WHERE tenant_id=$1 AND knowledge_base_id=ANY($2::uuid[])`,
    [tenantId, knowledgeBaseIds],
  );
  return rows.map((row) => String(row.knowledge_base_id));
}

export async function replaceDraftKnowledgeBases(
  actorId: string,
  tenantId: string,
  projectId: string,
  versionId: string,
  knowledgeBaseIds: string[],
): Promise<void> {
  await transaction(async (client) => {
    const allowed = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ai_project_versions version JOIN ai_applications app ON app.id=version.project_id
         JOIN ai_memberships membership ON membership.tenant_id=app.tenant_id
         WHERE version.id=$4 AND version.project_id=$3 AND version.status='draft' AND app.tenant_id=$2
           AND membership.user_id=$1 AND membership.role IN ('operator','admin')) AS allowed`,
      [actorId, tenantId, projectId, versionId],
    );
    if (!allowed.rows[0]?.allowed) throw new Error('没有项目管理权限');

    await client.query(
      `DELETE FROM ai_project_version_knowledge_bases
       WHERE project_version_id=$1 AND project_id=$2 AND tenant_id=$3`,
      [versionId, projectId, tenantId],
    );
    await executeMany(
      client,
      `INSERT INTO ai_project_version_knowledge_bases (project_version_id,knowledge_base_id,tenant_id,project_id)
       VALUES ($1,$4,$2,$3)`,
      knowledgeBaseIds.map((id) => [versionId, tenantId, projectId, id]),
    );
  });
}

/** 公开配置：只解析 active 项目的单个 published 版本，其余一律 404。 */
export async function getPublishedProjectConfig(publicId: string): Promise<ProjectVersionRecord | null> {
  const row = await queryOne<VersionRow & { project_status: string }>(
    `SELECT version.id AS version_id,version.project_id,app.public_id,app.status AS project_status,version.status,
            version.display_config,version.system_prompt,version.model_key,version.temperature,version.max_tokens,
            version.feature_flags
     FROM ai_applications app JOIN ai_project_versions version ON version.project_id=app.id
     WHERE app.public_id=$1 AND app.status='active' AND version.status='published'`,
    [publicId],
  );
  if (!row) return null;
  const record = toProjectVersion(row);
  record.projectId = record.publicId;
  record.projectStatus = String(row.project_status);
  return record;
}

/** 新建会话时唯一允许解析的运行时快照。 */
export async function getPublishedProjectRuntime(publicId: string): Promise<PublishedProjectRuntime | null> {
  const row = await queryOne<{
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
    `SELECT app.id AS project_id,app.public_id,app.tenant_id,version.id AS version_id,
            version.system_prompt,version.model_key,version.temperature,version.max_tokens,version.feature_flags,
            COALESCE(array_agg(link.knowledge_base_id) FILTER (WHERE link.knowledge_base_id IS NOT NULL), ARRAY[]::uuid[]) AS knowledge_base_ids
     FROM ai_applications app
     JOIN ai_project_versions version ON version.project_id=app.id AND version.status='published'
     LEFT JOIN ai_project_version_knowledge_bases link
       ON link.project_version_id=version.id AND link.project_id=app.id AND link.tenant_id=app.tenant_id
     WHERE app.public_id=$1 AND app.status='active'
     GROUP BY app.id,version.id`,
    [publicId],
  );
  if (!row) return null;
  return {
    projectId: String(row.public_id),
    internalProjectId: String(row.project_id),
    projectVersionId: String(row.version_id),
    tenantId: String(row.tenant_id),
    systemPrompt: String(row.system_prompt),
    modelKey: String(row.model_key),
    temperature: Number(row.temperature),
    maxTokens: Number(row.max_tokens),
    featureFlags: toJsonObject(row.feature_flags),
    knowledgeBaseIds: (row.knowledge_base_ids ?? []).map(String),
  };
}

export { execute };
