/**
 * HS256 JWT。与 Python 版 app/core/auth_token.py 使用同一 JWT_SECRET，
 * 两侧签发的 token 可以互相验证，便于迁移期双栈并存。
 */
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';
import { unauthorized } from '../errors';

const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const MIN_EXPIRES_IN_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

export interface AuthTokenPayload {
  sub: string;
  role: string;
  email?: string;
  [key: string]: unknown;
}

function secretKey(): Uint8Array {
  const secret = config.jwtSecret;
  if (secret) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 JWT_SECRET 或 AUTH_TOKEN_SECRET');
  }
  return new TextEncoder().encode('travel-local-dev-secret');
}

function expiresIn(seconds?: number | null): number {
  const raw = seconds ?? config.jwtExpiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
  return Math.min(Math.max(Math.trunc(raw), MIN_EXPIRES_IN_SECONDS), MAX_EXPIRES_IN_SECONDS);
}

export async function signAuthToken(
  payload: Record<string, unknown>,
  options: { expiresInSeconds?: number | null; now?: number } = {},
): Promise<string> {
  const issuedAt = options.now ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn(options.expiresInSeconds))
    .sign(secretKey());
}

export async function verifyAuthToken(token: string | null | undefined): Promise<AuthTokenPayload> {
  if (!token) throw unauthorized('缺少认证 token');
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    const sub = String(payload.sub ?? payload.userId ?? '').trim();
    if (!sub) throw unauthorized('认证身份无效');
    return { ...payload, sub } as AuthTokenPayload;
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') throw unauthorized('认证 token 已过期');
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw unauthorized('认证 token 无效');
  }
}
