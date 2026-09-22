/**
 * 密码哈希。格式与 Python 版 app/core/passwords.py 完全一致：
 * - 新密码写入 `pbkdf2_sha256$迭代次数$salt$digest`
 * - 兼容 Node 旧版 `scrypt$salt$digest`（crypto.scrypt 默认 N=16384, r=8, p=1）
 * 因此迁移后既有账号的密码无需重置。
 */
import { pbkdf2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const ALGORITHM = 'sha256';
const DEFAULT_ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function base64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export async function hashPassword(password: string, iterations: number = DEFAULT_ITERATIONS): Promise<string> {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少需要 8 位');
  const salt = randomBytes(16);
  const digest = await pbkdf2Async(password, salt, iterations, KEY_LENGTH, ALGORITHM);
  return `pbkdf2_sha256$${iterations}$${base64urlEncode(salt)}$${base64urlEncode(digest as Buffer)}`;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

async function verifyScrypt(password: string, encoded: string): Promise<boolean> {
  const [scheme, salt, rawDigest] = encoded.split('$', 3);
  if (scheme !== 'scrypt' || !salt || !rawDigest) return false;
  try {
    const actual = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
    return safeEqual(actual, base64urlDecode(rawDigest));
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const value = String(encoded ?? '');
  if (value.startsWith('scrypt$')) return verifyScrypt(password, value);
  try {
    const [scheme, rawIterations, rawSalt, rawDigest] = value.split('$', 4);
    if (scheme !== 'pbkdf2_sha256') return false;
    const iterations = Number.parseInt(rawIterations, 10);
    if (!Number.isFinite(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
    const salt = base64urlDecode(rawSalt);
    const expected = base64urlDecode(rawDigest);
    const actual = (await pbkdf2Async(password, salt, iterations, expected.length, ALGORITHM)) as Buffer;
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}
