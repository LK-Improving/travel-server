/**
 * 受信任的管理员预置脚本（首管理员 / 测试管理员创建通道）。
 *
 * 公开注册接口（app/api/auth/register）已强制忽略客户端 role、注册即普通用户，
 * 因此管理员**只能**经此受信任的服务端脚本创建，杜绝公开接口提权。
 *
 * 用法：
 *   npm run db:seed-admin                                  # 用默认 smoke 管理员凭据
 *   SEED_ADMIN_ACCOUNT=admin SEED_ADMIN_PASSWORD='xxx' npm run db:seed-admin
 *
 * 幂等：账号已存在时返回 'exists'，不报错。
 */
import { pathToFileURL } from 'node:url';
import { createUser } from '@/lib/repositories/conversations';

export async function ensureAdmin(account: string, password: string): Promise<'created' | 'exists'> {
  try {
    await createUser({ account, password, role: 'admin' });
    return 'created';
  } catch (error) {
    if (error instanceof Error && error.message === '账号已存在') return 'exists';
    throw error;
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const account = process.env.SEED_ADMIN_ACCOUNT ?? process.env.SMOKE_ADMIN_ACCOUNT ?? 'smoke_admin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? 'Smoke@12345';
  ensureAdmin(account, password)
    .then((result) => {
      console.log(`[seed-admin] ${account} -> ${result}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('[seed-admin] 失败：', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
