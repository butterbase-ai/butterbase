import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStripe, verifyGithub, verifyCustomHmac } from '../webhook-verifiers.js';

describe('verifyStripe', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"id":"evt_1"}');

  function sign(t: number, b: Buffer): string {
    const sig = createHmac('sha256', secret).update(`${t}.${b.toString('utf8')}`).digest('hex');
    return `t=${t},v1=${sig}`;
  }

  it('accepts a valid signature within tolerance', () => {
    const t = Math.floor(Date.now() / 1000);
    const result = verifyStripe(body, sign(t, body), secret, 300);
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    const result = verifyStripe(Buffer.from('tampered'), sign(t, body), secret, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects an expired timestamp', () => {
    const t = Math.floor(Date.now() / 1000) - 1000;
    const result = verifyStripe(body, sign(t, body), secret, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_outside_tolerance');
  });

  it('rejects a missing header', () => {
    const result = verifyStripe(body, undefined, secret, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_header');
  });
});

describe('verifyGithub', () => {
  const secret = 'gh_test';
  const body = Buffer.from('{"action":"push"}');
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts valid sha256 HMAC', () => {
    expect(verifyGithub(body, sig, secret).ok).toBe(true);
  });

  it('rejects mismatched signature', () => {
    expect(verifyGithub(body, 'sha256=deadbeef', secret).ok).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyGithub(body, undefined, secret).ok).toBe(false);
  });
});

describe('verifyCustomHmac', () => {
  const secret = 'custom';
  const body = Buffer.from('payload');
  const sig = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid HMAC under the configured header', () => {
    expect(verifyCustomHmac(body, sig, secret).ok).toBe(true);
  });

  it('rejects a wrong digest', () => {
    expect(verifyCustomHmac(body, 'wrong', secret).ok).toBe(false);
  });
});
