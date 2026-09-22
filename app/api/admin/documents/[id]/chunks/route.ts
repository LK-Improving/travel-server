import { route, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { listDocumentChunks } from '@/lib/repositories/knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request, params) => {
  await adminReader(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 50, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  return successResponse(await listDocumentChunks(params.id, limit, offset));
});
