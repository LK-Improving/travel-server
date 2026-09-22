/**
 * 数据库初始化：按文件名顺序执行 migrations/*.sql，已执行过的跳过。
 * 对应 Python 版 scripts/init_db.py。
 *
 * 用法：npm run db:init
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { closePool, execute, query, transaction } from '@/lib/db/pool';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');

async function ensureMigrationTable(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const rows = await query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

async function main(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log(`[db:init] ${MIGRATIONS_DIR} 下没有迁移文件`);
    return;
  }

  await ensureMigrationTable();
  const applied = await appliedMigrations();

  let count = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`[db:init] 跳过 ${filename}（已执行）`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    await transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [
        filename,
      ]);
    });
    count += 1;
    console.log(`[db:init] 已执行 ${filename}`);
  }

  console.log(`[db:init] 完成，共 ${files.length} 个迁移，本次执行 ${count} 个`);
}

main()
  .catch((error: unknown) => {
    console.error('[db:init] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
