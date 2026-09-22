import { z } from 'zod';
import { route, parseJson, successResponse, publicSubject } from '@/lib/http';
import { engagementService } from '@/lib/services/project_engagement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FeedbackPayload = z.object({ value: z.enum(['up', 'down']) });

export const PUT = route(async (request, params) => {
  const subject = await publicSubject(request);
  const body = await parseJson(request, FeedbackPayload);
  return successResponse(await engagementService.setFeedback(subject, params.id, params.mid, body.value));
});

export const DELETE = route(async (request, params) => {
  const subject = await publicSubject(request);
  return successResponse({ removed: await engagementService.removeFeedback(subject, params.id, params.mid) });
});
