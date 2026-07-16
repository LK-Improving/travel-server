import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import 'dotenv/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function getLocalPgConfig() {
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
  };
}

const pool = new Pool(getLocalPgConfig());

try {
  const migrationsDir = path.resolve(__dirname, '../migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`Migration executed: ${file}`);
  }

  console.log('Auth database initialized');
} finally {
  await pool.end();
}
