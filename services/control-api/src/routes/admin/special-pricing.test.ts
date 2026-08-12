import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import specialPricingRoutes from './special-pricing.js';

function makeControlDbMock(handlers: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number } | null) {
  const query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    const r = handlers(sql, params);
    return r ?? { rows: [], rowCount: 0 };
  });
  return { query, connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

async function makeApp(controlDb: any, isAdmin = true) {
  const app = Fastify({ logger: false });
  const fp = (await import('fastify-plugin')).default;
  await app.register(fp(async (i: any) => {
    const original = controlDb.query;
    controlDb.query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM platform_users') && sql.includes('is_admin')) {
        return { rows: [{ id: 'admin-uid', email: 'admin@example.com', display_name: null, is_admin: isAdmin }] };
      }
      return original(sql, params);
    });
    i.decorate('controlDb', controlDb);
    i.decorate('authProvider', { async verifyJwt() { return { sub: 'sub-1' }; } });
  }, { name: 'shim' }));
  await app.register(specialPricingRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer ok' };

describe('/admin/special-pricing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin with 403', async () => {
    const app = await makeApp(makeControlDbMock(() => null), false);
    const r = await app.inject({ method: 'GET', url: '/admin/special-pricing', headers: AUTH });
    expect(r.statusCode).toBe(403);
  });

  it('GET lists book entries', async () => {
    const db = makeControlDbMock((sql) =>
      sql.includes('FROM special_model_markups')
        ? { rows: [{ canonical_model_id: 'anthropic/claude-haiku-4.5', markup_pct: 12.5, updated_by: 'admin-uid', updated_at: '2026-08-12T00:00:00Z' }] }
        : null);
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: '/admin/special-pricing', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json().entries[0].canonical_model_id).toBe('anthropic/claude-haiku-4.5');
  });

  it('PUT upserts and returns the entry', async () => {
    let captured: unknown[] = [];
    const db = makeControlDbMock((sql, params) => {
      if (sql.includes('INSERT INTO special_model_markups')) {
        captured = params;
        return { rows: [{ canonical_model_id: params[0], markup_pct: params[1], updated_by: params[2], updated_at: '2026-08-12T00:00:00Z' }] };
      }
      return null;
    });
    const app = await makeApp(db);
    const r = await app.inject({
      method: 'PUT', url: '/admin/special-pricing', headers: AUTH,
      payload: { canonical_model_id: 'openai/gpt-image-2', markup_pct: 15 },
    });
    expect(r.statusCode).toBe(200);
    expect(captured[0]).toBe('openai/gpt-image-2');
    expect(captured[1]).toBe(15);
    expect(captured[2]).toBe('admin-uid');
  });

  it('PUT rejects out-of-range pct', async () => {
    const app = await makeApp(makeControlDbMock(() => null));
    const r = await app.inject({
      method: 'PUT', url: '/admin/special-pricing', headers: AUTH,
      payload: { canonical_model_id: 'a/b', markup_pct: 201 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_markup_pct');
  });

  it('PUT rejects missing model id', async () => {
    const app = await makeApp(makeControlDbMock(() => null));
    const r = await app.inject({
      method: 'PUT', url: '/admin/special-pricing', headers: AUTH,
      payload: { markup_pct: 10 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('canonical_model_id_required');
  });

  it('DELETE removes by ?model= and 404s when absent', async () => {
    const db = makeControlDbMock((sql, params) =>
      sql.includes('DELETE FROM special_model_markups')
        ? { rows: [], rowCount: params[0] === 'a/b' ? 1 : 0 }
        : null);
    const app = await makeApp(db);
    const hit = await app.inject({ method: 'DELETE', url: `/admin/special-pricing?model=${encodeURIComponent('a/b')}`, headers: AUTH });
    expect(hit.statusCode).toBe(204);
    const miss = await app.inject({ method: 'DELETE', url: `/admin/special-pricing?model=${encodeURIComponent('x/y')}`, headers: AUTH });
    expect(miss.statusCode).toBe(404);
  });

  it('PATCH org toggle updates flag and audits', async () => {
    const sqls: string[] = [];
    const db = makeControlDbMock((sql, params) => {
      sqls.push(sql);
      if (sql.includes('UPDATE organizations')) {
        return { rows: [{ id: 'org-1', special_pricing: params[0] }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO billing_events')) return { rows: [] };
      return null;
    });
    const app = await makeApp(db);
    const r = await app.inject({
      method: 'PATCH', url: '/admin/organizations/org-1/special-pricing', headers: AUTH,
      payload: { special_pricing: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: 'org-1', special_pricing: true });
    expect(sqls.some(s => s.includes('INSERT INTO billing_events'))).toBe(true);
  });

  it('PATCH 404s for unknown org', async () => {
    const db = makeControlDbMock((sql) =>
      sql.includes('UPDATE organizations') ? { rows: [], rowCount: 0 } : null);
    const app = await makeApp(db);
    const r = await app.inject({
      method: 'PATCH', url: '/admin/organizations/nope/special-pricing', headers: AUTH,
      payload: { special_pricing: true },
    });
    expect(r.statusCode).toBe(404);
  });
});
