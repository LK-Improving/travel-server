/**
 * POST /api/travel/chat
 * 对齐旧 src/routers/travel.js 的 /chat：SSE 流式旅游对话。
 * 鉴权为 optional（登录后落地用户记忆，未登录则匿名对话）。
 */
import { z } from 'zod';
import { route, parseJson, sseResponse, currentUser } from '@/lib/http';
import { travelService } from '@/lib/services/travel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().max(64).optional(),
});

export const POST = route(async (request) => {
  const body = await parseJson(request, ChatSchema);

  let userId: string | undefined;
  try {
    const user = await currentUser(request);
    userId = user.id;
  } catch {
    userId = undefined;
  }

  return sseResponse(async (emit) => {
    for await (const frame of travelService.streamChat(body.message, {
      userId,
      conversationId: body.conversationId,
    })) {
      emit(frame);
    }
  });
});
