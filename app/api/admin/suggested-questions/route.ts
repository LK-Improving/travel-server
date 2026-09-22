import { z } from 'zod';
import { route, parseJson, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader, adminWriter } from '@/lib/auth/subject';
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

export const GET = route(async (request) => {
  await adminReader(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 50, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  const enabledRaw = query.get('enabled');
  const enabled = enabledRaw === null ? null : enabledRaw === 'true';
  return successResponse(await adminService.listSuggestedQuestions(limit, offset, enabled));
});

export const POST = route(async (request) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, Payload);
  return successResponse(await adminService.createSuggestedQuestion(body, user.id), 201);
});
