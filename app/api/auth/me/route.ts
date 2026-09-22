import { route, successResponse } from '@/lib/http';
import { currentUser } from '@/lib/auth/subject';

export const runtime = 'nodejs';

export const GET = route(async (request) => {
  const user = await currentUser(request);
  return successResponse({
    id: user.id,
    role: user.role,
    email: user.email ?? null,
  });
});
