import { Pool } from 'pg';
import 'dotenv/config.js';

let pool = null;

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function getPgConfig() {
  const connectionString =
    cleanEnv(process.env.AUTH_DB_URL) ||
    cleanEnv(process.env.PG_URL) ||
    cleanEnv(process.env.DATABASE_URL);

  if (connectionString) {
    return { connectionString };
  }

  const password = cleanEnv(process.env.AUTH_DB_PASSWORD) || cleanEnv(process.env.PGPASSWORD);
  if (!password && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 AUTH_DB_PASSWORD 或 PGPASSWORD');
  }

  return {
    host: cleanEnv(process.env.AUTH_DB_HOST) || cleanEnv(process.env.PGHOST) || 'localhost',
    port: Number(cleanEnv(process.env.AUTH_DB_PORT) || cleanEnv(process.env.PGPORT) || 5432),
    database: cleanEnv(process.env.AUTH_DB_NAME) || cleanEnv(process.env.PGDATABASE) || 'travel',
    user: cleanEnv(process.env.AUTH_DB_USER) || cleanEnv(process.env.PGUSER) || 'postgres',
    password: password || 'root',
    max: Number(cleanEnv(process.env.AUTH_DB_POOL_MAX) || 10),
    idleTimeoutMillis: Number(cleanEnv(process.env.AUTH_DB_IDLE_TIMEOUT_MS) || 30000),
  };
}

export function getPgPool() {
  if (pool) return pool;
  pool = new Pool(getPgConfig());
  return pool;
}

export async function query(sql, params = []) {
  return getPgPool().query(sql, params);
}
