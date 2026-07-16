import { query } from './postgresClient.js';

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 8000;

function normalizeText(value, maxLength) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return metadata;
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function toFavorite(row) {
  return {
    id: row.id,
    userId: row.user_id,
    targetType: row.target_type,
    targetId: row.target_id,
    title: row.title,
    content: row.content,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class FavoriteServer {
  async list(userId, options = {}) {
    const limit = normalizeInteger(options.limit, 20, 1, 100);
    const offset = normalizeInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const result = await query(
      `SELECT id, user_id, target_type, target_id, title, content, metadata, created_at, updated_at
       FROM travel_favorites
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return {
      success: true,
      data: result.rows.map(toFavorite),
      pagination: {
        limit,
        offset,
      },
    };
  }

  async create(userId, payload) {
    const title = normalizeText(payload.title, MAX_TITLE_LENGTH);
    const content = normalizeText(payload.content, MAX_CONTENT_LENGTH);
    const targetType = normalizeText(payload.targetType || payload.target_type || 'travel_plan', 32);
    const targetId = normalizeText(payload.targetId || payload.target_id, 255) || null;
    const metadata = normalizeMetadata(payload.metadata);

    if (!title) {
      throw new Error('收藏标题不能为空');
    }

    const result = await query(
      `INSERT INTO travel_favorites (user_id, target_type, target_id, title, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, target_type, target_id)
       WHERE target_id IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, metadata = EXCLUDED.metadata
       RETURNING id, user_id, target_type, target_id, title, content, metadata, created_at, updated_at`,
      [userId, targetType, targetId, title, content || null, metadata],
    );

    return {
      success: true,
      data: toFavorite(result.rows[0]),
    };
  }

  async remove(userId, favoriteId) {
    const result = await query(
      `DELETE FROM travel_favorites
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [favoriteId, userId],
    );

    if (!result.rowCount) {
      throw new Error('收藏不存在或无权删除');
    }

    return {
      success: true,
      id: favoriteId,
    };
  }
}

export default new FavoriteServer();
