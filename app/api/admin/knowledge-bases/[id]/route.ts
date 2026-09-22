import { z } from 'zod';
import { route, parseJson, successResponse, notFound } from '@/lib/http';
import { adminReader, adminWriter } from '@/lib/auth/subject';
import { getKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase } from '@/lib/repositories/knowledge';

export const runtime = 'nodejs';

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const GET = route(async (request, params) => {
  await adminReader(request);
  const kb = await getKnowledgeBase(params.id);
  if (!kb) throw notFound('知识库不存在');
  return successResponse(kb);
});

export const PUT = route(async (request, params) => {
  await adminWriter(request);
  const body = await parseJson(request, UpdateSchema);
  const kb = await updateKnowledgeBase(params.id, body);
  if (!kb) throw notFound('知识库不存在');
  return successResponse(kb);
});

export const DELETE = route(async (request, params) => {
  await adminWriter(request);
  const ok = await deleteKnowledgeBase(params.id);
  if (!ok) throw notFound('知识库不存在');
  return successResponse({ id: params.id, deleted: true });
});
