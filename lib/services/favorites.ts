/**
 * 用户收藏（Node 版原有能力，Python 版没有对应模块，迁移时保留）。
 * 对齐旧实现 src/services/favoriteServer.js 的字段与行为。
 */
import { query, queryOne, execute } from '../db/pool';
import { toJsonObject } from '../db/pool';

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 8000;

export interface FavoriteRecord {
  id: string;
  userId: string;
  targetType: string;
  targetId: string | null;
  title: string;
  content: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

interface FavoriteRow {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string | null;
  title: string;
  content: string | null;
  metadata: unknown;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

function normalizeText(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return toJsonObject(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toFavorite(row: FavoriteRow): FavoriteRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    targetType: row.target_type,
    targetId: row.target_id,
    title: row.title,
    content: row.content,
    metadata: normalizeMetadata(row.metadata),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const COLUMNS = 'id,user_id,target_type,target_id,title,content,metadata,created_at,updated_at';

export class FavoriteService {
  async list(userId: string, options: { limit?: unknown; offset?: unknown } = {}): Promise<{
    items: FavoriteRecord[];
    pagination: { limit: number; offset: number };
  }> {
    const limit = clampInt(options.limit, 20, 1, 100);
    const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = await query<FavoriteRow>(
      `SELECT ${COLUMNS} FROM travel_favorites
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return { items: rows.map(toFavorite), pagination: { limit, offset } };
  }

  /**
   * 同一 (user, type, target) 重复收藏时更新而非报错：
   * 依赖 travel_favorites 上的部分唯一索引，target_id 为空时不走 upsert。
   */
  async create(
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<FavoriteRecord> {
    const title = normalizeText(payload.title, MAX_TITLE_LENGTH);
    const content = normalizeText(payload.content, MAX_CONTENT_LENGTH);
    const targetType = normalizeText(payload.targetType ?? payload.target_type ?? 'travel_plan', 32);
    const targetId = normalizeText(payload.targetId ?? payload.target_id, 255) || null;
    const metadata = normalizeMetadata(payload.metadata);
    if (!title) throw new Error('收藏标题不能为空');

    const row = await queryOne<FavoriteRow>(
      `INSERT INTO travel_favorites (user_id,target_type,target_id,title,content,metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (user_id,target_type,target_id) WHERE target_id IS NOT NULL
       DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,metadata=EXCLUDED.metadata,updated_at=NOW()
       RETURNING ${COLUMNS}`,
      [userId, targetType, targetId, title, content || null, JSON.stringify(metadata)],
    );
    if (!row) throw new Error('创建收藏失败');
    return toFavorite(row);
  }

  async remove(userId: string, favoriteId: string): Promise<{ id: string }> {
    const affected = await execute('DELETE FROM travel_favorites WHERE id=$1 AND user_id=$2', [
      favoriteId,
      userId,
    ]);
    if (!affected) throw new Error('收藏不存在或无权删除');
    return { id: favoriteId };
  }
}

export const favoriteService = new FavoriteService();
