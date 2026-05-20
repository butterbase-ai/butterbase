import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { getRedisClient } from '../redis.js';

const VERIFY_CACHE_TTL = 300; // 5 minutes
const verifyCacheKey = (plaintext: string, hash: string) =>
  `argon2:verify:${createHash('sha256').update(`${plaintext}:${hash}`).digest('hex')}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 alphabet

const COMMON_DENYLIST = new Set([
  'password', 'passw0rd', '12345678', '123456789', 'qwerty12',
  'letmein!', 'welcome1', 'changeme',
]);

export function generateCode(): string {
  const buf = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += BASE32[buf[i] % 32];
  }
  return out;
}

export async function hashCode(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyCode(plaintext: string, hash: string): Promise<boolean> {
  if (hash === 'MIGRATION_PLACEHOLDER_ROTATE_REQUIRED') return false;

  const cacheKey = verifyCacheKey(plaintext, hash);
  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached === '1') return true;
  } catch {
    // Redis unavailable — fall through to argon2
  }

  try {
    const ok = await argon2.verify(hash, plaintext);
    if (ok) {
      getRedisClient().setex(cacheKey, VERIFY_CACHE_TTL, '1').catch(() => {});
    }
    return ok;
  } catch {
    return false;
  }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateCustomCode(input: string): ValidationResult {
  if (input !== input.trim()) return { ok: false, reason: 'leading_or_trailing_whitespace' };
  if (input.length < 8) return { ok: false, reason: 'too_short' };
  if (input.length > 64) return { ok: false, reason: 'too_long' };
  if (!/^[\x21-\x7E]+$/.test(input)) return { ok: false, reason: 'invalid_chars' };
  if (COMMON_DENYLIST.has(input.toLowerCase())) return { ok: false, reason: 'too_common' };
  return { ok: true };
}
