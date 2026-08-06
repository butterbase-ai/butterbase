import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

/**
 * The AI gateway routes raise Fastify's body limit above the 1 MB default so
 * that conversation histories carrying base64 images don't 413 partway through
 * a session. These tests pin the mechanism: a route-level `bodyLimit` must win
 * over the instance default, otherwise the option is inert and the fix is a
 * no-op that nobody notices until a customer reports it again.
 */
const ONE_MB = 1024 * 1024;
const AI_BODY_LIMIT_BYTES = 25 * ONE_MB;

function bodyOfBytes(bytes: number): string {
  // {"d":"AAA…"} — pad the filler so the serialized body lands on `bytes`.
  const envelope = '{"d":""}'.length;
  return JSON.stringify({ d: 'A'.repeat(bytes - envelope) });
}

describe('gateway body limit', () => {
  it('rejects a 1.8 MB body on a route using the default limit', async () => {
    const app = Fastify();
    app.post('/default', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST', url: '/default',
      headers: { 'content-type': 'application/json' },
      payload: bodyOfBytes(Math.floor(1.8 * ONE_MB)),
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it('accepts the same body on a route carrying the AI body limit', async () => {
    const app = Fastify();
    app.post('/ai', { bodyLimit: AI_BODY_LIMIT_BYTES }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST', url: '/ai',
      headers: { 'content-type': 'application/json' },
      payload: bodyOfBytes(Math.floor(1.8 * ONE_MB)),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still rejects a body past the raised limit', async () => {
    const app = Fastify();
    app.post('/ai', { bodyLimit: ONE_MB * 2 }, async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST', url: '/ai',
      headers: { 'content-type': 'application/json' },
      payload: bodyOfBytes(Math.floor(2.5 * ONE_MB)),
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});
