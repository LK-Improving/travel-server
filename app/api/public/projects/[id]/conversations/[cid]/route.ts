import { route, parseQuery, readInt, successResponse, publicSubject } from '@/lib/http';
import { projectChatService } from '@/lib/services/project_chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request, params) => {
  const subject = await publicSubject(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 50, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  return successResponse(await projectChatService.listMessages(params.id, params.cid, subject, limit, offset));
});

export const DELETE = route(async (request, params) => {
  const subject = await publicSubject(request);
  return successResponse(await projectChatService.deleteConversation(params.id, params.cid, subject));
});
