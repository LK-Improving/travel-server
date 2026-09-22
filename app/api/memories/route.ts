/**
 * GET    /api/memories                 —— 列出当前用户的短期记忆（近 N 条，时间正序）
 * DELETE /api/memories?conversationId= —— 清空指定会话（缺省 default）的记忆与摘要
 * 对齐旧 src/routers/memories.js（requireAuth 保护）。
 */
import { route, successResponse, parseQuery, readString } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';
import { userMemoryService } from '@/lib/services/userMemory';

export const runtime = 'nodejs';

export const GET = route(async (request) => {
  const user = await currentUser(request);
  const params = parseQuery(request);
  const result = await userMemoryService.list(
    user.id,
    readString(params, 'conversationId'),
    readString(params, 'limit'),
  );
  return successResponse(result);
});

export const DELETE = route(async (request) => {
  const user = await currentUser(request);
  const params = parseQuery(request);
  const result = await userMemoryService.clear(user.id, readString(params, 'conversationId'));
  return successResponse(result);
});
