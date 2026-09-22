import { route, successResponse, publicSubject } from '@/lib/http';
import { engagementService } from '@/lib/services/project_engagement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (request, params) => {
  const subject = await publicSubject(request);
  return successResponse(await engagementService.favorite(subject, params.id, params.cid));
});

export const DELETE = route(async (request, params) => {
  const subject = await publicSubject(request);
  return successResponse({ favorited: false, removed: await engagementService.unfavorite(subject, params.id, params.cid) });
});
