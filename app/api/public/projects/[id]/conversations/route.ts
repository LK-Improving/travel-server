import { z } from 'zod';
import { route, parseJson, parseQuery, readInt, successResponse, publicSubject } from '@/lib/http';
import { projectChatService } from '@/lib/services/project_chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreatePayload = z.object({ title: z.string().min(1).max(160).default('新对话') });

export const GET = route(async (request, params) => {
  const subject = await publicSubject(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 50, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  return successResponse(await projectChatService.listConversations(params.id, subject, limit, offset));
});

export const POST = route(async (request, params) => {
  const subject = await publicSubject(request);
  const body = await parseJson(request, CreatePayload);
  return successResponse(await projectChatService.createConversation(params.id, subject, body.title), 201);
});
