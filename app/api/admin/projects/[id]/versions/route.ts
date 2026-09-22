import { route, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { projectService } from '@/lib/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request, params) => {
  const user = await adminReader(request);
  return successResponse(await projectService.listVersions(user.id, params.id));
});
