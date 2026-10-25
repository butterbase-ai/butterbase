import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Standalone runtime build context cannot import control-api. Keep the wire
// contract interoperable with services/control-api/src/services/cron-origin.ts.
// This is classification only, never authorization.
export function verifyCronOrigin(token: unknown, appId: string, secret: string | undefined, nowMs = Date.now()): token is string {
  if (!secret || typeof token !== 'string' || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try {
    const [payload, signature] = parts;
    const expected = createHmac('sha256', secret).update('butterbase:cron-origin:v1.' + payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(nowMs / 1000);
    return claims.appId === appId && Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp)
      && claims.iat <= now + 30 && claims.exp > now && claims.exp > claims.iat;
  } catch { return false; }
}

/** Attest a verified descendant for its own configured execution budget. */
export function cronOriginForExecution(token: unknown, appId: string, secret: string | undefined, timeoutMs: number, nowMs = Date.now()): string | undefined {
  if (!verifyCronOrigin(token, appId, secret, nowMs)) return undefined;
  const iat = Math.floor(nowMs / 1000);
  const required = Math.ceil(timeoutMs / 1000) + 35;
  const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  if (claims.exp >= iat + required) return token;
  const budget = Math.max(900, required);
  const payload = Buffer.from(JSON.stringify({ appId, iat, exp: iat + budget })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret!).update('butterbase:cron-origin:v1.' + payload).digest('base64url')}`;
}
