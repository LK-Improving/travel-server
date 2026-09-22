import { z } from 'zod';
import { route, parseJson, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader, adminWriter } from '@/lib/auth/subject';
import { listKnowledgeBases, createKnowledgeBase } from '@/lib/repositories/knowledge';

export const runtime = 'nodejs';

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

export const GET = route(async (request) => {
  const user = await adminReader(request);
  const q = parseQuery(request);
  const rows = await listKnowledgeBases(readInt(q, 'limit', 50), readInt(q, 'offset', 0));
  return successResponse(rows);
});

export const POST = route(async (request) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, CreateSchema);
  const kb = await createKnowledgeBase({ name: body.name, description: body.description, status: body.status }, user.id);
  return successResponse(kb, 201);
});
