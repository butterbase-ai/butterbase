import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { requireAdmin } from './admin-guard.js';

describe('requireAdmin', () => {
  it('returns 401 when authorization header is missing', async () => {
    const app = Fastify();
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, { query: vi.fn() } as any, mockAuthProvider());
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test' });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 when JWT verify throws', async () => {
    const app = Fastify();
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, { query: vi.fn() } as any, mockAuthProvider({ throws: true }));
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer bad' } });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const app = Fastify();
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u1', email: 'x@x', display_name: null, is_admin: false }] }) };
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, ctrl as any, mockAuthProvider({ sub: 'sub-1' }));
      if (!u) return;
      return { ok: true };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(403);
  });

  it('returns the user when authorized', async () => {
    const app = Fastify();
    const ctrl = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'u1', email: 'a@b', display_name: null, is_admin: true }] }) };
    app.get('/test', { config: { public: true } }, async (req, reply) => {
      const u = await requireAdmin(req, reply, ctrl as any, mockAuthProvider({ sub: 'sub-1' }));
      if (!u) return;
      return { user: u };
    });
    const r = await app.inject({ method: 'GET', url: '/test', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).user.id).toBe('u1');
  });
});

function mockAuthProvider(opts: { sub?: string; throws?: boolean } = {}) {
  return {
    async verifyJwt(_token: string) {
      if (opts.throws) throw new Error('bad jwt');
      return { sub: opts.sub ?? 'sub-1' };
    },
  } as any;
}
