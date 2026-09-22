import { z } from 'zod';
import { route, parseJson, parseQuery, readInt, successResponse } from '@/lib/http';
import { adminReader, adminWriter } from '@/lib/auth/subject';
import { listAdminDocuments } from '@/lib/repositories/knowledge';
import { documentIngestionService } from '@/lib/services/document_ingestion';

export const runtime = 'nodejs';

const UploadSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  content: z.string().min(1),
  title: z.string().max(200).optional(),
  regions: z.array(z.string()).max(20).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});

export const GET = route(async (request) => {
  await adminReader(request);
  const q = parseQuery(request);
  const rows = await listAdminDocuments({
    knowledgeBaseId: q.get('knowledgeBaseId') ?? undefined,
    status: q.get('status') ?? undefined,
    limit: readInt(q, 'limit', 50),
    offset: readInt(q, 'offset', 0),
  });
  return successResponse(rows);
});

export const POST = route(async (request) => {
  const user = await adminWriter(request);
  const body = await parseJson(request, UploadSchema);
  const doc = await documentIngestionService.upload({ ...body, actorId: user.id });
  return successResponse(doc, 201);
});
