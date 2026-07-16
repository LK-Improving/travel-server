import pg from "pg";
import dns from "node:dns/promises";
import "dotenv/config.js";

const { Pool } = pg;

function cleanEnv(value) {
  return typeof value === "string" ? value.trim() : value;
}

function boolEnv(value, defaultValue = true) {
  const cleaned = cleanEnv(value);
  if (!cleaned) return defaultValue;
  return !["false", "0", "no"].includes(cleaned.toLowerCase());
}

function buildConnectionConfig() {
  const connectionString = cleanEnv(process.env.SUPABASE_DB_URL);
  if (connectionString) return { connectionString };

  const projectRef = cleanEnv(process.env.SUPABASE_PROJECT_REF);
  const password = cleanEnv(process.env.SUPABASE_DB_PASSWORD);
  const host =
    cleanEnv(process.env.SUPABASE_DB_HOST) ||
    (projectRef ? `db.${projectRef}.supabase.co` : "");
  const port = cleanEnv(process.env.SUPABASE_DB_PORT) || "5432";
  const database = cleanEnv(process.env.SUPABASE_DB_NAME) || "postgres";
  const user = cleanEnv(process.env.SUPABASE_DB_USER) || "postgres";

  if (!host || !password) {
    throw new Error("缺少 Supabase 数据库连接配置");
  }

  return {
    host,
    port: Number(port),
    database,
    user,
    password,
  };
}

function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("embedding 不能为空");
  }

  const values = embedding.map((value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  });

  return `[${values.join(",")}]`;
}

function normalizeLimit(value, fallback) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), 20);
}

class SupabaseRagStore {
  constructor() {
    this.pool = null;
    this.poolPromise = null;
    this.initPromise = null;
  }

  async getPool() {
    if (this.pool) return this.pool;
    if (this.poolPromise) return this.poolPromise;

    this.poolPromise = this.createPool();
    this.pool = await this.poolPromise;
    return this.pool;
  }

  async createPool() {
    const connectionConfig = buildConnectionConfig();
    const shouldResolveIpv4 =
      connectionConfig.host && boolEnv(process.env.SUPABASE_DB_RESOLVE_IPV4, true);
    const servername = connectionConfig.host;

    if (shouldResolveIpv4) {
      const addresses = await dns.resolve4(connectionConfig.host);
      if (addresses.length > 0) {
        connectionConfig.host = addresses[0];
      }
    }

    return new Pool({
      ...connectionConfig,
      max: Number(process.env.SUPABASE_DB_POOL_SIZE || 5),
      ssl: boolEnv(process.env.SUPABASE_DB_SSL, true)
        ? { rejectUnauthorized: false, servername }
        : false,
    });
  }

  async init() {
    if (this.initPromise) return this.initPromise;

    const pool = await this.getPool();
    this.initPromise = pool.query(`
      create extension if not exists vector;
      create extension if not exists pgcrypto;

      create table if not exists travel_rag_documents (
        id uuid primary key default gen_random_uuid(),
        title text not null default '',
        content text not null,
        chunk text not null,
        chunk_index integer not null default 0,
        metadata jsonb not null default '{}'::jsonb,
        embedding vector not null,
        created_at timestamptz not null default now()
      );

      create index if not exists travel_rag_documents_metadata_idx
        on travel_rag_documents using gin (metadata);

      create index if not exists travel_rag_documents_created_at_idx
        on travel_rag_documents (created_at desc);
    `);

    return this.initPromise;
  }

  async addChunks({ title, content, chunks, embeddings, metadata = {} }) {
    await this.init();

    if (chunks.length !== embeddings.length) {
      throw new Error("切片数量和 embedding 数量不一致");
    }

    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");

      const inserted = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const result = await client.query(
          `
            insert into travel_rag_documents
              (title, content, chunk, chunk_index, metadata, embedding)
            values ($1, $2, $3, $4, $5::jsonb, $6::vector)
            returning id, title, chunk_index, created_at
          `,
          [
            title,
            content,
            chunks[index],
            index,
            JSON.stringify(metadata),
            toVectorLiteral(embeddings[index]),
          ],
        );
        inserted.push(result.rows[0]);
      }

      await client.query("commit");
      return inserted;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async search({ embedding, matchCount, threshold }) {
    await this.init();

    const limit = normalizeLimit(matchCount, Number(process.env.RAG_MATCH_COUNT || 5));
    const minSimilarity =
      threshold === undefined || threshold === null || threshold === ""
        ? null
        : Number(threshold);

    const pool = await this.getPool();
    const result = await pool.query(
      `
        select
          id,
          title,
          chunk,
          chunk_index,
          metadata,
          created_at,
          1 - (embedding <=> $1::vector) as similarity
        from travel_rag_documents
        where ($3::float8 is null or 1 - (embedding <=> $1::vector) >= $3::float8)
        order by embedding <=> $1::vector
        limit $2
      `,
      [
        toVectorLiteral(embedding),
        limit,
        Number.isFinite(minSimilarity) ? minSimilarity : null,
      ],
    );

    return result.rows;
  }
}

export default new SupabaseRagStore();
