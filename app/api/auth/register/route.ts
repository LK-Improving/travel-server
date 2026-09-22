import { z } from 'zod';
import { route, parseJson, successResponse, conflict } from '@/lib/http';
import { createUser } from '@/lib/repositories/conversations';

export const runtime = 'nodejs';

const RegisterSchema = z.object({
  account: z.string().min(3).max(120),
  password: z.string().min(6).max(200),
  email: z.string().email().optional(),
  nickname: z.string().max(120).optional(),
  role: z.enum(['user', 'admin', 'operator', 'viewer']).default('user'),
});

export const POST = route(async (request) => {
  const body = await parseJson(request, RegisterSchema);
  let user;
  try {
    user = await createUser({
      account: body.account,
      password: body.password,
      email: body.email,
      nickname: body.nickname,
      role: body.role,
    });
  } catch (error) {
    // 仓储层抛的是普通 Error，直接冒泡会变成 500；账号重复应是 409 冲突语义。
    if (error instanceof Error && error.message === '账号已存在') throw conflict('账号已存在');
    throw error;
  }
  return successResponse({ id: user.id, account: user.email, nickname: user.nickname, role: user.role }, 201);
});
