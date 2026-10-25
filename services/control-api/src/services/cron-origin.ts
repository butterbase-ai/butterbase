import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Classification metadata only. This envelope never grants API permissions.
// Deno's standalone verifier implements this same wire contract; interoperability
// is exercised by the generated-worker HTTP tests.
export const CRON_ORIGIN_HEADER = 'x-butterbase-cron-origin';
const DOMAIN = 'butterbase:cron-origin:v1.';
const TTL_SECONDS = 900;
const context = new AsyncLocalStorage<{ appId: string; token?: string }>();

export function signCronOrigin(
  appId: string,
  secret = process.env.BUTTERBASE_INTERNAL_SECRET,
  nowMs = Date.now(),
): string {
  if (!secret) throw new Error('BUTTERBASE_INTERNAL_SECRET is required for cron dispatch');
  if (!appId) throw new Error('appId is required for cron origin');
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ appId, iat, exp: iat + TTL_SECONDS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(DOMAIN + payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyCronOrigin(
  token: unknown,
  appId: string,
  secret = process.env.BUTTERBASE_INTERNAL_SECRET,
  nowMs = Date.now(),
): token is string {
  if (!secret || typeof token !== 'string' || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    const [payload, signature] = parts;
    const expected = createHmac('sha256', secret).update(DOMAIN + payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(nowMs / 1000);
    return claims.appId === appId && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp)
      && claims.iat <= now + 30 && claims.exp > now && claims.exp > claims.iat
      && claims.exp - claims.iat <= TTL_SECONDS;
  } catch { return false; }
}

export function withCronOrigin(appId: string, token: unknown, next: () => void): void {
  context.run({ appId, token: verifyCronOrigin(token, appId) ? token : undefined }, next);
}

/** Preserve a verified origin through platform-triggered function dispatches. */
export function cronOriginHeaders(appId: string): Record<string, string> {
  const current = context.getStore();
  return current?.appId === appId && verifyCronOrigin(current.token, appId)
    ? { [CRON_ORIGIN_HEADER]: current.token }
    : {};
}
