import { route, successResponse } from '@/lib/http';
import { createRagTools } from '@/lib/rag_base/tools';
import { zodToJsonSchema } from '@/lib/utils/zodJson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const tools = createRagTools();
  return successResponse(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: zodToJsonSchema(tool.schema as never),
    })),
  );
});
