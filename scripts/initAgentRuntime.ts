/**
 * 初始化 LangGraph Agent 运行时表（checkpoint / checkpoint_writes / checkpoint_blobs）。
 * 表结构与 Python 版 langgraph-checkpoint-postgres 完全一致，两侧可共用同一库。
 *
 * 用法：npm run db:init-agent-runtime
 */
import { getCheckpointer } from '@/lib/infra/checkpointer';
import { closePool } from '@/lib/db/pool';

async function main(): Promise<void> {
  const saver = await getCheckpointer();
  console.log('[agent-runtime] checkpoint 表已就绪：', saver.constructor.name);
}

main()
  .catch((error: unknown) => {
    console.error('[agent-runtime] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
