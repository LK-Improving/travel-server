import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { projectService } from '@/lib/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TestPayload = z.object({
  requestText: z.string().min(1).max(4000),
  answerText: z.string().min(1).max(20000),
  citedChunkIds: z.array(z.string()).max(100).default([]),
  elapsedMs: z.number().int().min(0).max(600000).default(0),
  passed: z.boolean().nullable().default(null),
});

export const POST = route(async (request, params) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, TestPayload);
  return successResponse(await projectService.createTest(user.id, params.id, params.versionId, body as Record<string, unknown>), 201);
});
