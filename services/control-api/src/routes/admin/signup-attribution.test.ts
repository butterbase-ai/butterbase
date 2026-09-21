import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// This route guards with routes/admin-auth.js, whose auth provider is a module
// -level singleton (unlike lib/admin-guard.js, which takes one as an argument
// and so can be injected). Mocking the guard is the only way to exercise the
// handler without a real Cognito/JWT round-trip.
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

import signupAttributionRoutes from './signup-attribution.js';

function makeControlDbMock(
  handlers: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number } | null,
) {
  const query = vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
    const r = handlers(sql, params);
    return r ?? { rows: [], rowCount: 0 };
  });
  return { query, connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
}

async function makeApp(controlDb: any, isAdmin = true) {
  adminState.isAdmin = isAdmin;
  const app = Fastify({ logger: false });
  const fp = (await import('fastify-plugin')).default;
  await app.register(
    fp(
      async (i: any) => {
        i.decorate('controlDb', controlDb);
      },
      { name: 'shim' },
    ),
  );
  await app.register(signupAttributionRoutes);
  return app;
}

const AUTH = { authorization: 'Bearer ok' };
const URL_BASE = '/admin/metrics/signup-attribution';

/** Classify which of the endpoint's queries a given SQL string is. */
function kindOf(sql: string): 'kpis' | 'source' | 'campaign' | 'referrer' | 'recent' | null {
  // Match on the SELECT alias, not on the regex literals: once a campaign
  // filter is applied every query contains the utm_campaign pattern.
  if (sql.includes('total_signups')) return 'kpis';
  if (sql.includes('AS campaign') && sql.includes('GROUP BY')) return 'campaign';
  if (sql.includes('AS source') && sql.includes('GROUP BY')) return 'source';
  if (sql.includes('signup_referrer IS NOT NULL') && sql.includes('GROUP BY')) return 'referrer';
  if (sql.includes('ORDER BY pu.created_at DESC')) return 'recent';
  return null;
}

describe('/admin/metrics/signup-attribution — utm_campaign', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin with 403', async () => {
    const app = await makeApp(makeControlDbMock(() => null), false);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(r.statusCode).toBe(403);
  });

  it('returns a by_campaign breakdown alongside by_source', async () => {
    const db = makeControlDbMock((sql) => {
      switch (kindOf(sql)) {
        case 'kpis':
          return { rows: [{ total_signups: '10', tagged_signups: '6', with_referrer: '4' }] };
        case 'campaign':
          return {
            rows: [
              { campaign: 'qwen-promo-2026-09', count: '4' },
              { campaign: '(none)', count: '2' },
            ],
          };
        case 'source':
          return { rows: [{ source: 'linkedin', count: '6' }] };
        default:
          return null;
      }
    });
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });

    expect(r.statusCode).toBe(200);
    expect(r.json().by_campaign).toEqual([
      { campaign: 'qwen-promo-2026-09', count: 4 },
      { campaign: '(none)', count: 2 },
    ]);
  });

  it('binds the campaign filter as a parameter rather than inlining it', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const db = makeControlDbMock((sql, params) => {
      seen.push({ sql, params });
      return null;
    });
    const app = await makeApp(db);
    const r = await app.inject({
      method: 'GET',
      url: `${URL_BASE}?campaign=qwen-promo-2026-09`,
      headers: AUTH,
    });

    expect(r.statusCode).toBe(200);
    const filtered = seen.filter((s) => kindOf(s.sql) === 'kpis' || kindOf(s.sql) === 'recent');
    expect(filtered.length).toBeGreaterThan(0);
    for (const s of filtered) {
      // The value must never appear inline in the SQL text.
      expect(s.sql).not.toContain('qwen-promo-2026-09');
      expect(s.params).toContain('qwen-promo-2026-09');
    }
  });

  it('leaves the campaign list unfiltered so the dropdown keeps every option', async () => {
    // Without this the dropdown would collapse to the single selected campaign
    // after the first selection, with no way back to the others.
    const seen: { sql: string; params: unknown[] }[] = [];
    const db = makeControlDbMock((sql, params) => {
      seen.push({ sql, params });
      return null;
    });
    const app = await makeApp(db);
    await app.inject({ method: 'GET', url: `${URL_BASE}?campaign=only-this`, headers: AUTH });

    const campaignQ = seen.find((s) => kindOf(s.sql) === 'campaign');
    expect(campaignQ).toBeDefined();
    expect(campaignQ!.params).not.toContain('only-this');
  });

  it('echoes the active campaign, and null when none is set', async () => {
    const app = await makeApp(makeControlDbMock(() => null));

    const withFilter = await app.inject({
      method: 'GET',
      url: `${URL_BASE}?campaign=spring`,
      headers: AUTH,
    });
    expect(withFilter.json().campaign).toBe('spring');

    const without = await app.inject({ method: 'GET', url: URL_BASE, headers: AUTH });
    expect(without.json().campaign).toBeNull();
  });

  it('treats a blank campaign param as no filter', async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const db = makeControlDbMock((sql, params) => {
      seen.push({ sql, params });
      return null;
    });
    const app = await makeApp(db);
    const r = await app.inject({ method: 'GET', url: `${URL_BASE}?campaign=`, headers: AUTH });

    expect(r.json().campaign).toBeNull();
    for (const s of seen) expect(s.params).toEqual([]);
  });
});
