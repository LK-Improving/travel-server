/**
 * 租户授权的项目/版本生命周期与发布配置红脱敏。
 * 对齐 Python 版 app/services/projects.py。
 */
import {
  listProjectCreationOptions,
  resolveProject,
  listProjectsForActor,
  createProject,
  listProjectVersions,
  getProjectVersion,
  saveDraftWithKnowledgeBases,
  createTestRun,
  publishProjectVersion,
  createDraftFromVersion,
  setProjectStatus,
  getPublishedProjectConfig,
  getPublishedProjectRuntime,
  type ProjectVersionRecord,
  type ProjectDraftPayload,
} from '../repositories/projects';
import { projectModelCatalog, ModelUnavailableError } from './projectModels';
import { DomainConflictError, DomainValidationError, LookupError, PermissionError } from '../errors';

const READER_ROLES = new Set(['viewer', 'operator', 'admin']);
const WRITER_ROLES = new Set(['operator', 'admin']);
const ADMIN_ROLES = new Set(['admin']);

function toPublicId(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  const publicId = result.publicId ?? result.public_id;
  if (publicId) result.projectId = publicId;
  delete result.publicId;
  delete result.public_id;
  return result;
}

function versionPayload(version: Record<string, unknown>): Record<string, unknown> {
  return {
    publicId: version.publicId,
    name: version.name,
    description: version.description ?? '',
    logoUrl: version.logoUrl,
    themeColor: version.themeColor ?? '#1677FF',
    welcomeMessage: version.welcomeMessage ?? '',
    inputPlaceholder: version.inputPlaceholder ?? '',
    suggestedQuestions: version.suggestedQuestions ?? [],
    systemPrompt: version.systemPrompt,
    modelKey: version.modelKey,
    temperature: version.temperature,
    maxTokens: version.maxTokens,
    featureFlags: version.featureFlags ?? {},
    knowledgeBaseIds: version.knowledgeBaseIds ?? [],
  };
}

export class ProjectService {
  readonly catalog = projectModelCatalog;

  private async role(actorId: string, tenantId: string): Promise<string | null> {
    const memberships = await listProjectCreationOptions(actorId);
    for (const membership of memberships) {
      if (String(membership.tenantId) === String(tenantId)) {
        return String(membership.role || '').toLowerCase() || null;
      }
    }
    return null;
  }

  async authorizeProject(
    actorId: string,
    publicId: string,
    roles: Set<string> = READER_ROLES,
  ): Promise<Record<string, unknown> & { membershipRole: string }> {
    const project = await resolveProject(publicId);
    if (!project) throw new LookupError('项目不存在');
    const role = await this.role(actorId, String(project.tenantId));
    if (role === null || !roles.has(role)) {
      throw new PermissionError('没有当前项目的访问权限');
    }
    return { ...project, membershipRole: role };
  }

  private validate(payload: Record<string, unknown>): Record<string, unknown> {
    const modelKey = payload.modelKey;
    if (modelKey === undefined || modelKey === null || modelKey === '') {
      throw new Error('modelKey 必填');
    }
    this.catalog.require(String(modelKey));
    return payload;
  }

  async listProjects(actorId: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const membership of await listProjectCreationOptions(actorId)) {
      const tenantId = String(membership.tenantId);
      const role = String(membership.role || '').toLowerCase();
      for (const project of await listProjectsForActor(actorId, tenantId)) {
        const item = toPublicId(project as unknown as Record<string, unknown>);
        item.tenantId = tenantId;
        item.membershipRole = role;
        rows.push(item);
      }
    }
    return rows;
  }

  async creationOptions(actorId: string): Promise<Record<string, unknown>> {
    const tenants = (await listProjectCreationOptions(actorId)).map((tenant) => {
      const role = String(tenant.role || '').toLowerCase();
      return { ...tenant, canCreate: WRITER_ROLES.has(role) };
    });
    return { tenants, models: this.catalog.listOptions() };
  }

  async createProject(
    actorId: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const role = await this.role(actorId, tenantId);
    if (!role || !WRITER_ROLES.has(role)) {
      throw new PermissionError('没有项目创建权限');
    }
    const parsed = this.validate(payload);
    const result = await createProject(
      actorId,
      tenantId,
      { ...parsed, publicId: crypto.randomUUID(), name: String(parsed.name ?? '') } as never,
      Array.isArray(parsed.knowledgeBaseIds) ? (parsed.knowledgeBaseIds as string[]) : [],
    );
    return toPublicId(result as unknown as Record<string, unknown>);
  }

  async listVersions(actorId: string, publicId: string): Promise<Record<string, unknown>[]> {
    const project = await this.authorizeProject(actorId, publicId);
    const versions = await listProjectVersions(
      String(project.tenantId),
      String(project.projectId),
    );
    return versions.map((item) => toPublicId(item as unknown as Record<string, unknown>));
  }

  async getVersion(actorId: string, publicId: string, versionId: string): Promise<Record<string, unknown>> {
    const project = await this.authorizeProject(actorId, publicId);
    const value = await getProjectVersion(
      String(project.tenantId),
      String(project.projectId),
      versionId,
    );
    if (!value) throw new LookupError('项目版本不存在');
    return toPublicId(value as unknown as Record<string, unknown>);
  }

  async updateDraft(
    actorId: string,
    publicId: string,
    versionId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const project = await this.authorizeProject(actorId, publicId, WRITER_ROLES);
    const parsed = this.validate(payload);
    const result = await saveDraftWithKnowledgeBases(
      actorId,
      String(project.tenantId),
      String(project.projectId),
      versionId,
      parsed as unknown as ProjectDraftPayload,
      Array.isArray(parsed.knowledgeBaseIds) ? (parsed.knowledgeBaseIds as string[]) : [],
    );
    if (!result) throw new DomainConflictError('版本不存在、已发布或不可编辑');
    return toPublicId(result as unknown as Record<string, unknown>);
  }

  async createTest(
    actorId: string,
    publicId: string,
    versionId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const project = await this.authorizeProject(actorId, publicId, WRITER_ROLES);
    return createTestRun(
      actorId,
      String(project.tenantId),
      String(project.projectId),
      versionId,
      payload as unknown as {
        requestText: string;
        answerText: string;
        citedChunkIds: string[];
        elapsedMs: number;
        passed: boolean | null;
      },
    ) as unknown as Record<string, unknown>;
  }

  async publish(actorId: string, publicId: string, versionId: string): Promise<Record<string, unknown>> {
    const project = await this.authorizeProject(actorId, publicId, ADMIN_ROLES);
    const version = await getProjectVersion(
      String(project.tenantId),
      String(project.projectId),
      versionId,
    );
    if (!version) throw new LookupError('项目版本不存在');
    if (String(version.status) !== 'draft') {
      throw new DomainConflictError('仅草稿版本可以发布');
    }
    this.validate(versionPayload(version as unknown as Record<string, unknown>));
    const result = await publishProjectVersion(
      actorId,
      String(project.tenantId),
      String(project.projectId),
      versionId,
    );
    return toPublicId(result as unknown as Record<string, unknown>);
  }

  async copyDraft(actorId: string, publicId: string, versionId: string): Promise<Record<string, unknown>> {
    const project = await this.authorizeProject(actorId, publicId, ADMIN_ROLES);
    const result = await createDraftFromVersion(
      actorId,
      String(project.tenantId),
      String(project.projectId),
      versionId,
    );
    if (!result) throw new LookupError('只能从当前项目的已发布或历史版本复制草稿');
    return toPublicId(result as unknown as Record<string, unknown>);
  }

  async setStatus(actorId: string, publicId: string, status: string): Promise<Record<string, unknown>> {
    // 在边界把字符串收窄成联合类型，非法值在进库前就报出来，而不是靠数据库约束兜底。
    if (status !== 'active' && status !== 'disabled') {
      throw new DomainValidationError('status 只能取 active 或 disabled');
    }
    const project = await this.authorizeProject(actorId, publicId, ADMIN_ROLES);
    return setProjectStatus(
      actorId,
      String(project.tenantId),
      String(project.projectId),
      status,
    ) as unknown as Record<string, unknown>;
  }

  async publicConfig(publicId: string): Promise<Record<string, unknown>> {
    const value = await getPublishedProjectConfig(publicId);
    if (!value) throw new LookupError('项目不存在');
    const flags = { ...(value.featureFlags ?? {}) } as Record<string, unknown>;
    return {
      projectId: value.publicId ?? value.projectId ?? publicId,
      name: value.name ?? '',
      description: value.description ?? '',
      logoUrl: value.logoUrl,
      themeColor: value.themeColor ?? '#1677FF',
      welcomeMessage: value.welcomeMessage ?? '',
      inputPlaceholder: value.inputPlaceholder ?? '',
      suggestedQuestions:
        flags.suggestedQuestionsEnabled === false ? [] : (value.suggestedQuestions ?? []),
      featureFlags: flags,
    };
  }

  async publishedRuntime(publicId: string): Promise<Record<string, unknown>> {
    const value = await getPublishedProjectRuntime(publicId);
    if (!value) throw new LookupError('项目不存在');
    return value as unknown as Record<string, unknown>;
  }
}

export const projectService = new ProjectService();
