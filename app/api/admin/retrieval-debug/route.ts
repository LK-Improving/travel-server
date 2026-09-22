import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminReader } from '@/lib/auth/subject';
import { ragService } from '@/lib/services/rag';
import { dependencyUnavailable } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  knowledgeBaseId: z.string().min(1),
  query: z.string().min(1).max(4000),
  regions: z.array(z.string()).max(3).default([]),
  limit: z.number().int().min(1).max(10).default(5),
  sparseVariant: z.enum(['pg_trgm', 'elasticsearch', 'ab']).nullable().default(null),
});

export const POST = route(async (request) => {
  await adminReader(request);
  const body = await parseJson(request, Schema);
  try {
    const hits = await ragService.retrieve(body.query, {
      regions: body.regions,
      knowledgeBaseId: body.knowledgeBaseId,
      limit: body.limit,
      sparseVariant: body.sparseVariant,
    });
    return successResponse({ hits });
  } catch {
    throw dependencyUnavailable('检索服务暂时不可用');
  }
});
