import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { adminService } from '@/lib/services/admin';

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
  await adminWriter(request);
  const body = await parseJson(request, Payload);
  return successResponse(await adminService.updateSuggestedQuestion(params.id, body));
});

export const DELETE = route(async (request, params) => {
  await adminWriter(request);
  return successResponse(await adminService.deleteSuggestedQuestion(params.id));
});
