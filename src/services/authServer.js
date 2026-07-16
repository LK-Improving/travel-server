import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './postgresClient.js';
import { signAuthToken } from './authToken.js';

const scrypt = promisify(scryptCallback);
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  const value = String(username || '').trim().toLowerCase();
  return value || null;
}

function assertEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('邮箱格式不正确');
  }
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 64) {
    throw new Error('密码长度必须为 8-64 位');
  }
}

function assertUsername(username) {
  if (!username) return;
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new Error('用户名只能包含字母、数字、下划线，长度 3-32 位');
  }
}

function toSafeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  return `${PASSWORD_HASH_PREFIX}$${salt}$${key.toString('base64url')}`;
}

async function verifyPassword(password, passwordHash) {
  const [prefix, salt, savedKey] = String(passwordHash || '').split('$');
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !savedKey) return false;

  const key = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  const savedBuffer = Buffer.from(savedKey, 'base64url');
  return savedBuffer.length === key.length && timingSafeEqual(savedBuffer, key);
}

class AuthServer {
  async register({ email, username, password, nickname }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);
    const safeNickname = String(nickname || '').trim() || normalizedUsername || '旅行用户';

    assertEmail(normalizedEmail);
    assertUsername(normalizedUsername);
    assertPassword(password);

    const passwordHash = await hashPassword(password);

    try {
      const result = await query(
        `INSERT INTO travel_users (email, username, password_hash, nickname)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, username, nickname, avatar_url, role, status, last_login_at, created_at, updated_at`,
        [normalizedEmail, normalizedUsername, passwordHash, safeNickname],
      );

      const user = toSafeUser(result.rows[0]);
      return {
        success: true,
        user,
        token: signAuthToken({
          sub: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        }),
      };
    } catch (error) {
      if (error.code === '23505') {
        throw new Error('邮箱或用户名已被注册');
      }
      throw error;
    }
  }

  async login({ account, email, password }) {
    const loginAccount = normalizeEmail(account || email);
    assertPassword(password);

    if (!loginAccount) {
      throw new Error('请输入邮箱或用户名');
    }

    const result = await query(
      `SELECT id, email, username, password_hash, nickname, avatar_url, role, status, last_login_at, created_at, updated_at
       FROM travel_users
       WHERE email = $1 OR username = $1
       LIMIT 1`,
      [loginAccount],
    );
    const row = result.rows[0];

    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new Error('账号或密码错误');
    }

    if (row.status !== 'active') {
      throw new Error('账号已被禁用或锁定');
    }

    await query('UPDATE travel_users SET last_login_at = NOW() WHERE id = $1', [row.id]);
    const user = toSafeUser({
      ...row,
      last_login_at: new Date().toISOString(),
    });

    return {
      success: true,
      user,
      token: signAuthToken({
        sub: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      }),
    };
  }

  async getProfile(userId) {
    const result = await query(
      `SELECT id, email, username, nickname, avatar_url, role, status, last_login_at, created_at, updated_at
       FROM travel_users
       WHERE id = $1
       LIMIT 1`,
      [userId],
    );

    const user = toSafeUser(result.rows[0]);
    if (!user || user.status !== 'active') {
      throw new Error('用户不存在或不可用');
    }

    return {
      success: true,
      user,
    };
  }
}

export default new AuthServer();
