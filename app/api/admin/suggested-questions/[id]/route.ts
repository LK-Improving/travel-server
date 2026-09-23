import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { adminService } from '@/lib/services/admin';
import { recordAdminAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Payload = z.object({
  content: z.string().min(1).max(500),
  regions: z.array(z.string()).max(3).default([]),
  budgetRanges: z.array(z.string()).default([]),
  partySizes: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
  enabled: z.boolean().default(true),
});

export const PUT = route(async (request, params) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, Payload);
  const updated = await adminService.updateSuggestedQuestion(params.id, body);
  await recordAdminAudit({
    actorId: user.id,
    action: 'suggested_question.update',
    targetType: 'suggested_question',
    targetId: params.id,
  });
  return successResponse(updated);
});

export const DELETE = route(async (request, params) => {
  const user = await adminWriter(request);
  await adminService.deleteSuggestedQuestion(params.id);
  await recordAdminAudit({
    actorId: user.id,
    action: 'suggested_question.delete',
    targetType: 'suggested_question',
    targetId: params.id,
  });
  return successResponse({ id: params.id, deleted: true });
});
