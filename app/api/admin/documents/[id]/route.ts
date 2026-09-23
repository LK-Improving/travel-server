import { route, successResponse, notFound, conflict } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { getAdminDocument, deleteDocument } from '@/lib/repositories/knowledge';
import { recordAdminAudit } from '@/lib/audit';

export const runtime = 'nodejs';

export const GET = route(async (request, params) => {
  const user = await adminWriter(request);
  const doc = await getAdminDocument(params.id);
  if (!doc) throw notFound('文档不存在');
  return successResponse(doc);
});

export const DELETE = route(async (request, params) => {
  const user = await adminWriter(request);
  const ok = await deleteDocument(params.id);
  if (!ok) throw conflict('文档状态冲突或不存在');
  await recordAdminAudit({
    actorId: user.id,
    action: 'document.delete',
    targetType: 'document',
    targetId: params.id,
  });
  return successResponse({ id: params.id, deleted: true });
});
