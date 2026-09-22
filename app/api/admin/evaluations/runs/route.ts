import { route, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { evaluationService } from '@/lib/services/evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  await adminReader(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 20, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  const sparseBackend = query.get('sparseBackend');
  return successResponse(await evaluationService.listRuns(limit, offset, sparseBackend ?? null));
});
