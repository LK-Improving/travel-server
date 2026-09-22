/**
 * GET /api/memories/summary —— 获取当前用户指定会话的长期摘要。
 * 对齐旧 src/routers/memories.js 的 GET /summary。
 */
import { route, successResponse, parseQuery, readString } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';
import { userMemoryService } from '@/lib/services/userMemory';

export const runtime = 'nodejs';

export const GET = route(async (request) => {
  const user = await currentUser(request);
  const params = parseQuery(request);
  const summary = await userMemoryService.getSummary(user.id, readString(params, 'conversationId'));
  return successResponse({ summary });
});
