/**
 * GET  /api/favorites  —— 列出当前用户的收藏
 * POST /api/favorites  —— 新增/更新收藏（同一 user+type+target 去重）
 * 对齐旧 src/routers/favorites.js（requireAuth 保护）。
 */
import { z } from 'zod';
import { route, parseJson, successResponse, readInt, parseQuery } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';
import { favoriteService } from '@/lib/services/favorites';

export const runtime = 'nodejs';

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().max(8000).optional(),
  targetType: z.string().max(32).optional(),
  targetId: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const GET = route(async (request) => {
  const user = await currentUser(request);
  const params = parseQuery(request);
  const result = await favoriteService.list(user.id, {
    limit: readInt(params, 'limit', 20, 1, 100),
    offset: readInt(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
  });
  return successResponse(result);
});

export const POST = route(async (request) => {
  const user = await currentUser(request);
  const body = await parseJson(request, CreateSchema);
  const record = await favoriteService.create(user.id, body);
  return successResponse(record, 201);
});
