import { route, successResponse } from '@/lib/http';
import { projectService } from '@/lib/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (_request, params) => {
  return successResponse(await projectService.publicConfig(params.id));
});
