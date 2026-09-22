import { route, successResponse } from '@/lib/http';
import { skillRegistry } from '@/lib/skills/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  // 仅暴露版本化元信息，永不泄露运行时凭据。
  return successResponse(
    skillRegistry.manifests().map((manifest) => ({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
    })),
  );
});
