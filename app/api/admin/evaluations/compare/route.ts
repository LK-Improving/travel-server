import { route, parseQuery, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { evaluationService } from '@/lib/services/evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 按稀疏检索后端对比最近一次完成的评测运行。
 * 默认对比 pg_trgm 与 elasticsearch；可用 ?backends=pg_trgm,elasticsearch 指定。
 */
export const GET = route(async (request) => {
  await adminReader(request);
  const query = parseQuery(request);
  const backendsParam = query.get('backends');
  const backends = backendsParam
    ? backendsParam.split(',').map((value) => value.trim()).filter(Boolean)
    : undefined;
  return successResponse(await evaluationService.compareSparseBackends(backends));
});
