/**
 * 请求主体解析。对应 Python 版 app/routers/dependencies.py + app/services/identity.py。
 * 角色一律由服务端解析，绝不采信客户端提交的 role。
 */
import type { NextRequest } from 'next/server';
import { bearerToken, clientId } from '../http';
import { unauthorized, forbidden, BUSINESS_ERROR_CODES } from '../errors';
import { verifyAuthToken, type AuthTokenPayload } from './token';

export type SubjectKind = 'user' | 'client';

/** 持久化的会话归属主体。 */
export class Subject {
  readonly kind: SubjectKind;
  readonly id: string;

  constructor(kind: SubjectKind, id: string) {
    const value = String(id ?? '').trim();
    if (kind !== 'user' && kind !== 'client') throw new Error('Subject 类型无效');
    if (!value) throw new Error('Subject 无效');
    this.kind = kind;
    this.id = value;
  }

  get key(): string {
    return `${this.kind}:${this.id}`;
  }
}

export const READER_ROLES = new Set(['admin', 'operator', 'viewer']);
export const WRITER_ROLES = new Set(['admin', 'operator']);
export const ADMIN_ROLES = new Set(['admin']);

export interface CurrentUser {
  id: string;
  role: string;
  email?: string;
  payload: AuthTokenPayload;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 解析 Bearer token，失败抛 401。 */
export async function currentUser(request: NextRequest): Promise<CurrentUser> {
  const token = bearerToken(request);
  if (!token) throw unauthorized('请先登录');
  const payload = await verifyAuthToken(token);
  const role = String(payload.role ?? '').trim().toLowerCase();
  if (!role || !READER_ROLES.has(role)) throw unauthorized('认证身份无效');
  return { id: payload.sub, role, email: payload.email ? String(payload.email) : undefined, payload };
}

export async function adminReader(request: NextRequest): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!READER_ROLES.has(user.role)) throw forbidden('没有运营台访问权限');
  return user;
}

export async function adminWriter(request: NextRequest): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!WRITER_ROLES.has(user.role)) throw forbidden('没有运营台写入权限');
  return user;
}

/** 平台 Agent：优先 Bearer 用户，否则校验 X-Client-Id 为 UUID。 */
export async function publicSubject(request: NextRequest): Promise<Subject> {
  const token = bearerToken(request);
  if (token) {
    const payload = await verifyAuthToken(token);
    if (!payload.sub) throw unauthorized('认证身份无效');
    return new Subject('user', payload.sub);
  }
  const raw = clientId(request);
  if (!raw) throw unauthorized('请提供 Bearer 或 X-Client-Id');
  if (!UUID_PATTERN.test(raw)) throw unauthorized('X-Client-Id 必须为 UUID');
  return new Subject('client', raw.toLowerCase());
}

/** 要求已登录用户（用于收藏等必须绑定账号的操作）。 */
export function requireUser(subject: Subject): string {
  if (subject.kind !== 'user') {
    throw unauthorized('该功能需要登录后使用');
  }
  return subject.id;
}

export const AUTH_REQUIRED_CODE = BUSINESS_ERROR_CODES.AUTH_REQUIRED;
