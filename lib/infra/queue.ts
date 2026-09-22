/**
 * 文档解析任务队列。Python 版用 Redis/RQ，这里用 BullMQ + ioredis。
 * 契约保持一致：队列不可用时必须让文档停留在 draft/pending，
 * 绝不伪装成处理成功（见 Python 版 README 与文档处理契约）。
 */
import IORedis, { type RedisOptions } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config';

export const DOCUMENT_JOB_NAME = 'process_document';

export interface ProcessDocumentJob {
  documentId: string;
}

let connection: IORedis | null = null;
let queue: Queue<ProcessDocumentJob> | null = null;

function connectionOptions(): RedisOptions {
  return {
    // BullMQ 要求关闭 ioredis 自带的重试上限，否则长时间阻塞的 worker 会被踢断。
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  } as RedisOptions;
}

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(config.redisUrl, connectionOptions());
    connection.on('error', (error: Error) => {
      console.warn('[redis] connection error:', error.message);
    });
  }
  return connection;
}

export function getDocumentQueue(): Queue<ProcessDocumentJob> {
  if (!queue) {
    queue = new Queue<ProcessDocumentJob>(config.documentQueueName, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2_000 },
      },
    });
  }
  return queue;
}

export class DocumentQueueUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('文档任务队列暂时不可用，文档保持待处理状态');
    this.name = 'DocumentQueueUnavailableError';
    this.cause = cause;
  }
}

/** 入队文档解析任务。Redis 不可用时抛出，由调用方决定状态回滚。 */
export async function enqueueDocumentJob(documentId: string): Promise<string> {
  try {
    // BullMQ 禁止自定义 jobId 含 ':'（v5+ 起校验），否则 add() 直接抛 "Custom Id cannot contain :"，
    // 导致每次上传都入队失败、文档永久停在 draft。用 '-' 作分隔。
    const job = await getDocumentQueue().add(DOCUMENT_JOB_NAME, { documentId }, { jobId: `doc-${documentId}` });
    return String(job.id);
  } catch (error) {
    throw new DocumentQueueUnavailableError(error);
  }
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
