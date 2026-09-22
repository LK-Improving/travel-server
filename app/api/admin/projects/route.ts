import { z } from 'zod';
import { route, parseJson, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader, adminWriter } from '@/lib/auth/subject';
import { projectService } from '@/lib/services/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const draftFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  logoUrl: z.string().max(1000).nullable().default(null),
  themeColor: z.string().max(20).default('#1677FF'),
  welcomeMessage: z.string().max(2000).default(''),
  inputPlaceholder: z.string().max(200).default(''),
  suggestedQuestions: z.array(z.string()).default([]),
  systemPrompt: z.string().max(20000).default(''),
  modelKey: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(8192).default(2048),
  featureFlags: z.record(z.string(), z.boolean()).default({}),
  knowledgeBaseIds: z.array(z.string()).default([]),
};

const CreatePayload = z.object({
  tenantId: z.string().uuid(),
  ...draftFields,
});

export const GET = route(async (request) => {
  const user = await adminReader(request);
  const query = parseQuery(request);
  const limit = readInt(query, 'limit', 50, 1, 100);
  const offset = readInt(query, 'offset', 0, 0, 100000);
  void limit;
  void offset;
  return successResponse(await projectService.listProjects(user.id));
});

export const POST = route(async (request) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, CreatePayload);
  const { tenantId, ...values } = body;
  return successResponse(await projectService.createProject(user.id, tenantId, values as Record<string, unknown>), 201);
});
