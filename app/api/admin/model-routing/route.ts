import { route, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { modelRouter } from '@/lib/services/modelRouter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  await adminReader(request);
  return successResponse(modelRouter.publicConfig());
});
