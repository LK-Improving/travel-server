/**
 * 文档解析 Worker（BullMQ），对应 Python 版 app/workers/document_jobs.py 的常驻消费进程。
 *
 * 用法：
 *   npm run worker
 *   DOCUMENT_WORKER_CONCURRENCY=4 npm run worker
 *
 * 契约：解析失败时文档已被置为 failed，Worker 只负责把错误冒泡给 BullMQ 触发重试，
 * 绝不把失败的任务标记为成功。
 */
import { Worker, type Job } from 'bullmq';
import { config } from '@/lib/config';
import { DOCUMENT_JOB_NAME, getRedisConnection, type ProcessDocumentJob } from '@/lib/infra/queue';
import { documentProcessingService } from '@/lib/services/document_processing';

const concurrency = Math.max(1, Number(process.env.DOCUMENT_WORKER_CONCURRENCY ?? 2) || 2);

async function handle(job: Job<ProcessDocumentJob>): Promise<Record<string, unknown>> {
  if (job.name !== DOCUMENT_JOB_NAME) {
    throw new Error(`未知作业类型：${job.name}`);
  }
  const documentId = String(job.data?.documentId ?? '');
  if (!documentId) throw new Error('作业缺少 documentId');

  const startedAt = Date.now();
  const result = await documentProcessingService.process(documentId);
  const elapsed = Date.now() - startedAt;
  console.log(
    `[worker] 文档 ${documentId} 处理完成：${result.chunkCount} 个切片，` +
      `模型 ${result.embeddingModel}，耗时 ${elapsed}ms`,
  );
  return { ...result, elapsedMs: elapsed };
}

const worker = new Worker<ProcessDocumentJob>(config.documentQueueName, handle, {
  connection: getRedisConnection(),
  concurrency,
});

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} 完成`);
});

worker.on('failed', (job, error) => {
  const attempts = job?.attemptsMade ?? 0;
  console.error(`[worker] job ${job?.id} 失败（第 ${attempts} 次）：${error?.message}`);
});

worker.on('error', (error) => {
  console.error('[worker] 运行错误：', error);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] 收到 ${signal}，正在停止…`);
  try {
    await worker.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log(`[worker] 已启动：队列 ${config.documentQueueName}，并发 ${concurrency}`);
