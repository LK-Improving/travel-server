import { z } from 'zod';
import { route, parseJson, sseResponse, currentUser, applicationKey, validationError, notFound, forbidden } from '@/lib/http';
import { resolvePlatformApplicationContext, listApplicationKnowledgeBases } from '@/lib/repositories/platform';
import { runPlatformChat } from '@/lib/services/platform_agent_runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().uuid().default(() => crypto.randomUUID()),
});

export const POST = route(async (request) => {
  const user = await currentUser(request);
  const appKey = applicationKey(request);
  if (!appKey) throw validationError('缺少 X-Application-Key');
  const context = await resolvePlatformApplicationContext(appKey, user.id);
  if (!context) throw notFound('应用不存在或已停用');
  if (!context.membershipRole) throw forbidden('当前用户不属于该应用所在租户');

  const body = await parseJson(request, Schema);
  const knowledgeBaseIds = await listApplicationKnowledgeBases(context.tenantId, context.applicationId);
  const approval = request.headers.get('x-approval-token');

  return sseResponse(async (emit) => {
    for await (const frame of runPlatformChat({
      message: body.message,
      conversationId: body.conversationId ?? '',
      knowledgeBaseIds,
      context: {
        tenantId: context.tenantId,
        applicationId: context.applicationId,
        actorId: user.id,
        role: context.membershipRole ?? 'viewer',
        conversationId: body.conversationId,
        traceId: crypto.randomUUID(),
        approvalToken: approval,
      },
    })) {
      emit(frame);
    }
  });
});
