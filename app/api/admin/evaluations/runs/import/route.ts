import { z } from 'zod';
import { route, parseJson, successResponse } from '@/lib/http';
import { adminWriter } from '@/lib/auth/subject';
import { evaluationService } from '@/lib/services/evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Payload = z.object({
  manifest: z.record(z.string(), z.unknown()),
  cases: z.array(z.record(z.string(), z.unknown())).default([]),
  results: z.array(z.record(z.string(), z.unknown())),
});

export const POST = route(async (request) => {
  await adminWriter(request);
  const body = await parseJson(request, Payload);
  return successResponse(
    await evaluationService.importRun(body.manifest, body.cases, body.results ?? []),
    201,
  );
});
