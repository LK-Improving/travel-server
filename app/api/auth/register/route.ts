import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
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
  const user = await createUser({
    account: body.account,
    password: body.password,
    email: body.email,
    nickname: body.nickname,
    role: body.role,
  });
  return successResponse({ id: user.id, account: user.email, nickname: user.nickname, role: user.role }, 201);
});
