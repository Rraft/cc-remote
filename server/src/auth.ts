import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordRecord } from './config.js';

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

export const COOKIE_NAME = 'ccr_token';
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

// ---------- 密码哈希（scrypt，明文永不落盘） ----------

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.randomBytes(16).toString('hex');
  const keylen = 64;
  const hash = await scrypt(password.normalize('NFKC'), salt, keylen);
  return { salt, hash: hash.toString('hex'), keylen };
}

export async function verifyPassword(password: string, rec: PasswordRecord): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false;
  const hash = await scrypt(password.normalize('NFKC'), rec.salt, rec.keylen);
  const expected = Buffer.from(rec.hash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ---------- 会话 token（内存存储，服务重启需重新登录——更安全） ----------

const tokens = new Map<string, { expiresAt: number }>();

export function createToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function validateToken(token: string | undefined): boolean {
  if (!token) return false;
  const rec = tokens.get(token);
  if (!rec) return false;
  if (rec.expiresAt < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function revokeToken(token: string): void {
  tokens.delete(token);
}

/** 密码变更后调用：作废所有已登录会话，强制重新登录 */
export function clearAllTokens(): void {
  tokens.clear();
}

export const TOKEN_MAX_AGE_SEC = Math.floor(TOKEN_TTL_MS / 1000);

// ---------- 登录限速与指数锁定 ----------

type Bucket = { failures: number; lockedUntil: number };
const buckets = new Map<string, Bucket>();
const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

export function checkLock(key: string): { locked: boolean; retryAfterMs: number } {
  const b = buckets.get(key);
  if (!b) return { locked: false, retryAfterMs: 0 };
  const now = Date.now();
  if (b.lockedUntil > now) return { locked: true, retryAfterMs: b.lockedUntil - now };
  return { locked: false, retryAfterMs: 0 };
}

export function noteFailure(key: string): void {
  const b = buckets.get(key) ?? { failures: 0, lockedUntil: 0 };
  b.failures += 1;
  if (b.failures >= FREE_ATTEMPTS) {
    const exp = Math.min(b.failures - FREE_ATTEMPTS, 5);
    b.lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** exp, MAX_LOCK_MS);
  }
  buckets.set(key, b);
}

export function noteSuccess(key: string): void {
  buckets.delete(key);
}

// ---------- Cookie 工具（不引第三方依赖） ----------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildSessionCookie(token: string, secure: boolean): string {
  return (
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_MAX_AGE_SEC}` +
    (secure ? '; Secure' : '')
  );
}

export function buildClearCookie(secure: boolean): string {
  return (
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` + (secure ? '; Secure' : '')
  );
}
