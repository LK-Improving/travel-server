/**
 * PostgreSQL 连接池。asyncpg 与 node-postgres 都使用 $1 占位符，
 * 因此 Python 版 repositories/postgres.py 的 SQL 可以几乎原样迁移。
 */
import pg from 'pg';
import { QueryResultRow } from 'pg';
import { authDatabaseUrl, envInt } from '../config';

const { Pool, types } = pg;

// int8（COUNT 等聚合）在 node-postgres 默认是字符串，对齐 asyncpg 的整数语义。
types.setTypeParser(20, (value) => Number.parseInt(value, 10));
// numeric 保留字符串，避免浮点误差（金额、温度等由调用方显式转换）。
types.setTypeParser(1700, (value) => value);

interface PoolRegistry {
  authPool?: pg.Pool;
}

// Next.js 开发模式会热重载模块，用 globalThis 避免连接池泄漏。
const registry = globalThis as typeof globalThis & { __travelPool?: PoolRegistry };
const store: PoolRegistry = (registry.__travelPool ??= {});

export function getPool(): pg.Pool {
  if (!store.authPool) {
    const url = authDatabaseUrl();
    const ssl = /[?&]sslmode=require/.test(url) || process.env.AUTH_DB_SSL === 'true';
    store.authPool = new Pool({
      connectionString: url,
      max: envInt('AUTH_DB_POOL_MAX', 10),
      idleTimeoutMillis: envInt('AUTH_DB_IDLE_TIMEOUT_MS', 30_000),
      connectionTimeoutMillis: 10_000,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    store.authPool.on('error', (error: Error) => {
      console.error('[postgres] pool error:', error.message);
    });
  }
  return store.authPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function queryValue<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
  const row = await queryOne<Record<string, T>>(sql, params);
  if (!row) return null;
  return (Object.values(row)[0] as T) ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const result = await getPool().query(sql, params as never[]);
  return result.rowCount ?? 0;
}

/** 在单个连接上执行事务，异常自动回滚。 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** asyncpg 的 executemany 等价物。node-postgres 无内建批量，逐条执行即可。 */
export async function executeMany(client: pg.PoolClient | pg.Pool, sql: string, rows: unknown[][]): Promise<void> {
  for (const row of rows) {
    await client.query(sql, row as never[]);
  }
}

export async function closePool(): Promise<void> {
  if (store.authPool) {
    await store.authPool.end();
    store.authPool = undefined;
  }
}

// ---------- 列值归一化：兼容 node-postgres 与 asyncpg 的取值差异 ----------

export function toJsonList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

export function toJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown): T {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as T;
    } catch {
      return {} as T;
    }
  }
  return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as T;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

export function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toDateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
