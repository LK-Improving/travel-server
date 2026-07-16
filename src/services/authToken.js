import { createHmac, timingSafeEqual } from 'node:crypto';
import 'dotenv/config.js';

const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const MIN_EXPIRES_IN_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function getSecret() {
  const secret = cleanEnv(process.env.JWT_SECRET) || cleanEnv(process.env.AUTH_TOKEN_SECRET);
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 JWT_SECRET 或 AUTH_TOKEN_SECRET');
  }

  return 'travel-local-dev-secret';
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer.toString('base64url');
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function sign(input) {
  return createHmac('sha256', getSecret()).update(input).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeExpiresIn(value) {
  const seconds = Number(value || DEFAULT_EXPIRES_IN_SECONDS);
  if (!Number.isFinite(seconds)) return DEFAULT_EXPIRES_IN_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), MIN_EXPIRES_IN_SECONDS), MAX_EXPIRES_IN_SECONDS);
}

export function signAuthToken(payload, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = normalizeExpiresIn(options.expiresInSeconds || process.env.JWT_EXPIRES_IN_SECONDS);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(body)}`;
  return `${unsigned}.${sign(unsigned)}`;
}

export function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('缺少认证 token');
  }

  const [headerPart, payloadPart, signature] = token.split('.');
  if (!headerPart || !payloadPart || !signature) {
    throw new Error('认证 token 格式错误');
  }

  const unsigned = `${headerPart}.${payloadPart}`;
  if (!safeEqual(sign(unsigned), signature)) {
    throw new Error('认证 token 签名无效');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (_error) {
    throw new Error('认证 token 格式错误');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('认证 token 已过期');
  }

  return payload;
}
