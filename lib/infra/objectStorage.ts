/**
 * 文档原文件存储。与 Python 版 app/services/object_storage.py 对齐：
 * 生产走 MinIO（S3 兼容），未配置时降级到内存实现，便于本地先跑通链路。
 */
import { Client } from 'minio';
import { config } from '../config';
import { dependencyUnavailable } from '../errors';

export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  presignGet(key: string, expiresSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}

function parseEndpoint(endpoint: string): { endPoint: string; port: number } {
  const trimmed = endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const separator = trimmed.lastIndexOf(':');
  if (separator === -1) return { endPoint: trimmed, port: config.objectStorageSecure ? 443 : 80 };
  const port = Number.parseInt(trimmed.slice(separator + 1), 10);
  if (!Number.isFinite(port)) return { endPoint: trimmed, port: config.objectStorageSecure ? 443 : 80 };
  return { endPoint: trimmed.slice(0, separator), port };
}

class MinioObjectStorage implements ObjectStorage {
  private client: Client | null = null;

  private getClient(): Client {
    if (!this.client) {
      if (!config.objectStorageEndpoint || !config.objectStorageAccessKey || !config.objectStorageSecretKey) {
        throw new Error('对象存储配置不完整');
      }
      const { endPoint, port } = parseEndpoint(config.objectStorageEndpoint);
      this.client = new Client({
        endPoint,
        port,
        useSSL: config.objectStorageSecure,
        accessKey: config.objectStorageAccessKey,
        secretKey: config.objectStorageSecretKey,
        region: config.objectStorageRegion || undefined,
      });
    }
    return this.client;
  }

  private wrap(error: unknown): never {
    if (error instanceof Error && error.message === '对象存储配置不完整') throw error;
    throw dependencyUnavailable('对象存储暂时不可用');
  }

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    try {
      const client = this.getClient();
      const bucket = config.objectStorageBucket;
      const exists = await client.bucketExists(bucket);
      if (!exists) await client.makeBucket(bucket, config.objectStorageRegion || undefined);
      await client.putObject(bucket, key, data, data.byteLength, { 'Content-Type': contentType });
      return key;
    } catch (error) {
      this.wrap(error);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const stream = await this.getClient().getObject(config.objectStorageBucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.wrap(error);
    }
  }

  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    try {
      return await this.getClient().presignedGetObject(config.objectStorageBucket, key, expiresSeconds);
    } catch (error) {
      this.wrap(error);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.getClient().removeObject(config.objectStorageBucket, key);
    } catch (error) {
      this.wrap(error);
    }
  }
}

/** 未配置对象存储时的内存实现，仅用于本地联调，进程重启即丢失。 */
class InMemoryObjectStorage implements ObjectStorage {
  private readonly items = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    this.items.set(key, { data: Buffer.from(data), contentType });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const item = this.items.get(key);
    if (!item) throw dependencyUnavailable('对象不存在');
    return item.data;
  }

  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    if (!this.items.has(key)) throw dependencyUnavailable('对象不存在');
    return `https://storage.invalid/presigned?expires=${Math.trunc(expiresSeconds)}`;
  }

  async remove(key: string): Promise<void> {
    this.items.delete(key);
  }
}

function createObjectStorage(): ObjectStorage {
  if (config.objectStorageEndpoint && config.objectStorageAccessKey && config.objectStorageSecretKey) {
    return new MinioObjectStorage();
  }
  return new InMemoryObjectStorage();
}

export const objectStorage: ObjectStorage = createObjectStorage();
export const objectStorageBucket = config.objectStorageBucket;
