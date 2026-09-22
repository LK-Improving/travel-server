import { route, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { projectService } from '@/lib/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (request, params) => {
  const user = await adminWriter(request);
  return successResponse(await projectService.copyDraft(user.id, params.id, params.versionId));
});
