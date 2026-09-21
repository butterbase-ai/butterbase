import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const adminState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../admin-auth.js', () => ({
  requireAdmin: vi.fn(async (_app: unknown, _request: unknown, reply: any) => {
    if (!adminState.isAdmin) {
      reply.code(403).send({ error: 'Not authorized as admin' });
      return null;
    }
    return 'admin-uid';
  }),
}));

const fanOut = vi.hoisted(() => ({ rows: [] as { user_id: string | null }[], calls: [] as any[] }));
vi.mock('../../services/region-resolver.js', () => ({
  fanOutQuery: vi.fn(async (sql: string, params: unknown[]) => {
    fanOut.calls.push({ sql, params });
    return fanOut.rows;
  }),
}));

import promoUsageRoutes from './promo-usage.js';

function makeControlDbMock(rows: any[] = []) {
  const query = vi.fn().mockImplementation(async () => ({ rows, rowCount: rows.length }));
  return { query, connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

async function makeApp(controlDb: any, isAdmin = true) {
  adminState.isAdmin = isAdmin;
  const app = Fastify({ logger: false });
  const fp = (await import('fastify-plugin')).default;
  await app.register(fp(async (i: any) => i.decorate('controlDb', controlDb), { name: 'shim' }));
  await app.register(promoUsageRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer ok' };
const URL_BASE = '/admin/metrics/promo-usage';

describe('/admin/metrics/promo-usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fanOut.rows = [];
    fanOut.calls = [];
  });

  it('rejects non-admin with 403', async () => {
    const app = await makeApp(makeControlDbMock(), false);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(r.statusCode).toBe(403);
  });

  it('identifies coverage by router + charged_to_user + key_type', async () => {
    // promo_covered is not a column; if this triple ever drifts, the numbers
    // silently become wrong rather than failing loudly.
    const app = await makeApp(makeControlDbMock());
    await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    const { sql, params } = fanOut.calls[0];
    expect(sql).toContain('charged_to_user = false');
    expect(sql).toContain("key_type = 'platform'");
    expect(params[0]).toBe('provider-quaternary');
  });

  it('joins fanned-out user ids to their signup sources', async () => {
    fanOut.rows = [{ user_id: 'u1' }, { user_id: 'u2' }];
    const db = makeControlDbMock([
      { source: 'linkedin', users: '2' },
      { source: '(untagged)', users: '1' },
    ]);
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      promo_users: 2,
      by_source: [
        { source: 'linkedin', users: 2 },
        { source: '(untagged)', users: 1 },
      ],
    });
    expect(db.query.mock.calls[0][1]).toEqual([['u1', 'u2']]);
  });

  it('de-duplicates a user returned by more than one region', async () => {
    fanOut.rows = [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }];
    const db = makeControlDbMock([{ source: 'linkedin', users: '2' }]);
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.json().promo_users).toBe(2);
    expect(db.query.mock.calls[0][1]).toEqual([['u1', 'u2']]);
  });

  it('returns an empty report without touching the control DB when nobody qualifies', async () => {
    fanOut.rows = [];
    const db = makeControlDbMock();
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.json()).toMatchObject({ promo_users: 0, by_source: [] });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('drops null user ids rather than querying for them', async () => {
    fanOut.rows = [{ user_id: null }, { user_id: 'u1' }];
    const db = makeControlDbMock([{ source: 'linkedin', users: '1' }]);
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.json().promo_users).toBe(1);
    expect(db.query.mock.calls[0][1]).toEqual([['u1']]);
  });

  it('clamps the days window and falls back to 30 on junk input', async () => {
    const app = await makeApp(makeControlDbMock());

    const huge = await app.inject({ method: 'GET', url: `${URL_BASE}?days=99999`, headers: AUTH });
    expect(huge.json().days).toBe(365);

    const junk = await app.inject({ method: 'GET', url: `${URL_BASE}?days=abc`, headers: AUTH });
    expect(junk.json().days).toBe(30);

    const negative = await app.inject({ method: 'GET', url: `${URL_BASE}?days=-5`, headers: AUTH });
    expect(negative.json().days).toBe(30);
  });
});
