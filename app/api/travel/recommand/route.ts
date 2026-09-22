/**
 * POST /api/travel/recommand
 * 对齐旧 src/routers/travel.js 的 /recommand：根据城市/预算/天数生成结构化行程 JSON。
 * 沿用原路径拼写（recommand）以兼容既有前端调用。
 */
import { z } from 'zod';
import { route, parseJson, successResponse, badRequest } from '@/lib/http';
import { travelService } from '@/lib/services/travel';

export const runtime = 'nodejs';

const RecommendSchema = z.object({
  city: z.string().min(1).max(120),
  budget: z.union([z.number(), z.string()]).transform((value) => Number(value)),
  days: z.union([z.number(), z.string()]).transform((value) => Number(value)),
});

export const POST = route(async (request) => {
  const body = await parseJson(request, RecommendSchema);
  if (!body.city || !Number.isFinite(body.budget) || !Number.isFinite(body.days)) {
    throw badRequest('缺少必要参数 city、budget、days');
  }
  const result = await travelService.recommend(body.city, body.budget, body.days);
  return successResponse(result);
});
