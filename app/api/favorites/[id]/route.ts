/**
 * DELETE /api/favorites/:id —— 删除指定收藏（仅本人）。
 * 对齐旧 src/routers/favorites.js 的 DELETE /:id。
 */
import { route, successResponse, notFound } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';
import { favoriteService } from '@/lib/services/favorites';

export const runtime = 'nodejs';

export const DELETE = route(async (request, params) => {
  const user = await currentUser(request);
  const id = params.id;
  try {
    const result = await favoriteService.remove(user.id, id);
    return successResponse(result);
  } catch {
    throw notFound('收藏不存在或无权删除');
  }
});
