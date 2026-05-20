import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import internalAuthPlugin from './internal-auth.js';

describe('internal-auth plugin', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
    app = Fastify();
    await app.register(internalAuthPlugin);
    app.post('/v1/internal/lease/grant', async () => ({ ok: true }));
    app.post('/public/something', async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('rejects /v1/internal/* without the header', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/internal/lease/grant' });
    expect(r.statusCode).toBe(401);
  });

  it('rejects /v1/internal/* with wrong header', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/internal/lease/grant',
      headers: { 'x-butterbase-internal-secret': 'wrong' } });
    expect(r.statusCode).toBe(401);
  });

  it('accepts /v1/internal/* with correct header', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/internal/lease/grant',
      headers: { 'x-butterbase-internal-secret': 'test-secret' } });
    expect(r.statusCode).toBe(200);
  });

  it('does not gate non-internal routes', async () => {
    const r = await app.inject({ method: 'POST', url: '/public/something' });
    expect(r.statusCode).toBe(200);
  });
});
