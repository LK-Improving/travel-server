/**
 * 管理台 CRUD 薄服务层，对齐 Python 版 app/services/admin.py。
 * 所有越权/可见性校验在路由层（admin_reader/admin_writer）完成。
 */
import {
  listKnowledgeBases,
  createKnowledgeBase,
  getKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
} from '../repositories/knowledge';
import {
  type SuggestedQuestionInput,
  listAdminSuggestedQuestions,
  createSuggestedQuestion,
  updateSuggestedQuestion,
  deleteSuggestedQuestion,
  listAuditLogs,
} from '../repositories/adminRepo';
import { LookupError } from '../errors';

/**
 * 推荐问题的可选字段在此补默认值。
 * 路由层用 zod 校验后仍可能是 Partial，把缺省规则收在服务层，避免每个路由各写一遍。
 */
function normalizeSuggestedQuestion(payload: Partial<SuggestedQuestionInput>): SuggestedQuestionInput {
  return {
    content: String(payload.content ?? '').trim(),
    regions: payload.regions ?? [],
    budgetRanges: payload.budgetRanges ?? [],
    partySizes: payload.partySizes ?? [],
    sortOrder: Number(payload.sortOrder ?? 0),
    enabled: payload.enabled ?? true,
  };
}

export const adminService = {
  listKnowledgeBases: (limit: number, offset: number) => listKnowledgeBases(limit, offset),
  async createKnowledgeBase(payload: { name: string; description?: string; status?: string }, actorId: string) {
    return createKnowledgeBase(payload, actorId);
  },
  async getKnowledgeBase(knowledgeBaseId: string) {
    const value = await getKnowledgeBase(knowledgeBaseId);
    if (!value) throw new LookupError('知识库不存在');
    return value;
  },
  async updateKnowledgeBase(knowledgeBaseId: string, payload: Record<string, unknown>) {
    const value = await updateKnowledgeBase(knowledgeBaseId, payload);
    if (!value) throw new LookupError('知识库不存在');
    return value;
  },
  async deleteKnowledgeBase(knowledgeBaseId: string) {
    if (!(await deleteKnowledgeBase(knowledgeBaseId))) throw new LookupError('知识库不存在');
    return { id: knowledgeBaseId };
  },

  listSuggestedQuestions: (limit: number, offset: number, enabled: boolean | null) =>
    listAdminSuggestedQuestions(limit, offset, enabled),
  async createSuggestedQuestion(payload: Partial<SuggestedQuestionInput>, actorId: string) {
    return createSuggestedQuestion(normalizeSuggestedQuestion(payload), actorId);
  },
  async updateSuggestedQuestion(questionId: string, payload: Partial<SuggestedQuestionInput>) {
    const value = await updateSuggestedQuestion(questionId, normalizeSuggestedQuestion(payload));
    if (!value) throw new LookupError('推荐问题不存在');
    return value;
  },
  async deleteSuggestedQuestion(questionId: string) {
    if (!(await deleteSuggestedQuestion(questionId))) throw new LookupError('推荐问题不存在');
    return { id: questionId };
  },

  listAuditLogs: (limit: number, offset: number) => listAuditLogs(limit, offset),
};
