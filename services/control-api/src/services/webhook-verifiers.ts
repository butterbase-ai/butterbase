import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_header' | 'signature_mismatch' | 'timestamp_outside_tolerance' };

function safeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
  } catch {
    return false;
  }
}

export function verifyStripe(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds: number,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' };

  const parts = header.split(',').map((p) => p.trim());
  let t: number | null = null;
  const v1Sigs: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v) t = Number(v);
    else if (k === 'v1' && v) v1Sigs.push(v);
  }
  if (t === null || Number.isNaN(t) || v1Sigs.length === 0) {
    return { ok: false, reason: 'malformed_header' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  for (const sig of v1Sigs) {
    if (safeEqualHex(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

export function verifyGithub(rawBody: Buffer, header: string | undefined, secret: string): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' };
  if (!header.startsWith('sha256=')) return { ok: false, reason: 'malformed_header' };
  const sig = header.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(sig, expected) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export function verifyCustomHmac(rawBody: Buffer, header: string | undefined, secret: string): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' };
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(header, expected) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}
