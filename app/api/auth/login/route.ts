import { z } from 'zod';
import { route, parseJson, successResponse, errorResponse } from '@/lib/http';
import { authenticateUser } from '@/lib/repositories/conversations';
import { signAuthToken } from '@/lib/auth/token';
import { unauthorized } from '@/lib/errors';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  account: z.string().min(1).max(120),
  password: z.string().min(1).max(200),
});

export const POST = route(async (request) => {
  const body = await parseJson(request, LoginSchema);
  const user = await authenticateUser(body.account, body.password);
  if (!user) throw unauthorized('账号或密码错误');
  const token = await signAuthToken({ sub: user.id, role: user.role, email: user.email });
  return successResponse({
    token,
    user: { id: user.id, account: user.email, nickname: user.nickname, role: user.role, avatarUrl: user.avatarUrl },
  });
});
