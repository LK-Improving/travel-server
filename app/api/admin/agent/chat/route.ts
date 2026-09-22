import { z } from 'zod';
import { route, parseJson, sseResponse, adminReader } from '@/lib/http';
import { runRagChat } from '@/lib/services/rag_agent_runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatSchema = z.object({
  message: z.string().min(1).max(8000),
  conversation_id: z.string().uuid().optional(),
  budget_cny: z.union([z.number(), z.string()]).optional(),
});

export const POST = route(async (request) => {
  await adminReader(request);
  const body = await parseJson(request, ChatSchema);
  const threadId = body.conversation_id ?? crypto.randomUUID();
  return sseResponse(async (emit) => {
    for await (const frame of runRagChat({
      message: body.message,
      threadId,
      conversationId: body.conversation_id ?? null,
      budgetCny: body.budget_cny,
    })) {
      emit(frame);
    }
  });
});
