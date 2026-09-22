import { z } from 'zod';
import { route, successResponse, applicationKey, forbidden, notFound, validationError } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';
import { resolvePlatformApplicationContext, approveToolApproval } from '@/lib/repositories/platform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = z.string().uuid();

export const POST = route(async (request, params) => {
  const user = await currentUser(request);
  const appKey = applicationKey(request);
  if (!appKey) throw validationError('缺少 X-Application-Key');
  const parsed = UUID.safeParse(params.id);
  if (!parsed.success) throw validationError('approvalId 必须为 UUID');

  const context = await resolvePlatformApplicationContext(appKey, user.id);
  if (!context) throw notFound('应用不存在或已停用');
  if (!context.membershipRole) throw forbidden('当前用户不属于该应用所在租户');
  if (!['operator', 'admin'].includes(context.membershipRole)) {
    throw forbidden('只有运营人员可以确认高风险工具');
  }
  const result = await approveToolApproval(params.id, context.tenantId, user.id);
  if (!result) throw notFound('审批请求不存在、已过期或已处理');
  return successResponse(result);
});
