import { route, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { evaluationService } from '@/lib/services/evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request, params) => {
  await adminReader(request);
  return successResponse(await evaluationService.getRun(params.id));
});
