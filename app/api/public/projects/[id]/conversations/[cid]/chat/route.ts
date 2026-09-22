import { z } from 'zod';
import { route, parseJson, sseResponse, publicSubject } from '@/lib/http';
import { projectChatService } from '@/lib/services/project_chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatSchema = z.object({ message: z.string().min(1).max(8000) });

export const POST = route(async (request, params) => {
  const subject = await publicSubject(request);
  const body = await parseJson(request, ChatSchema);
  const runtime2 = await projectChatService.validateChat(params.id, params.cid, subject, body.message);
  return sseResponse(async (emit) => {
    for await (const frame of projectChatService.streamChat(params.id, params.cid, subject, body.message, runtime2 as never)) {
      emit(frame);
    }
  });
});
