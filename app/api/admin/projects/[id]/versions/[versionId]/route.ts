import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { projectService } from '@/lib/services/projects';
import { draftFields } from '@/app/api/admin/projects/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DraftPayload = z.object(draftFields);

export const PUT = route(async (request, params) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, DraftPayload);
  return successResponse(await projectService.updateDraft(user.id, params.id, params.versionId, body as Record<string, unknown>));
});
