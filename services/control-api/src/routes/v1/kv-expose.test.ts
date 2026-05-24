/**
 * kv-expose.test.ts — Integration tests for the kv-expose Fastify plugin.
 *
 * Requires:
 *   RUN_DB_TESTS=1
 *   KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390
 *   NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import {
  RUN_DB_TESTS,
  PLATFORM_URL,
  KV_REDIS_URL_US,
  buildAppWithDevKey,
  resetKvScope,
  cleanupFixture,
} from '../../services/kv/__test-utils__/kv-test-harness.js';
import kvExposeRoutes from './kv-expose.js';

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

let pool: pg.Pool;
let app: ReturnType<typeof Fastify>;
let appId: string;
let devKey: string;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  process.env.KV_REDIS_URL_US = KV_REDIS_URL_US;

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const fixture = await buildAppWithDevKey(pool, 'kv-expose');
  appId = fixture.appId;
  devKey = fixture.devKey;

  app = Fastify({ logger: false });
  app.decorate('controlDb', pool);
  await app.register(kvExposeRoutes);
  await app.ready();
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await app.close();
  await cleanupFixture(pool, appId);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  await resetKvScope(appId);
});

function req(
  method: string,
  url: string,
  opts: { payload?: unknown; token?: string } = {},
) {
  const token = opts.token ?? devKey;
  const hasBody = opts.payload !== undefined;
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    payload: hasBody ? JSON.stringify(opts.payload) : undefined,
  });
}

// ── GET _expose ─────────────────────────────────────────────────────────────────

describeDb('GET /v1/:app_id/kv/_expose', () => {
  it('returns empty rules when none set', async () => {
    const res = await req('GET', `/v1/${appId}/kv/_expose`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rules: [] });
  });

  it('returns rules sorted by declarationOrder after adding some', async () => {
    await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('user:**')}`, {
      payload: { read: 'authed', write: 'deny' },
    });
    await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('public:*')}`, {
      payload: { read: 'public', write: 'deny' },
    });

    const res = await req('GET', `/v1/${appId}/kv/_expose`);
    expect(res.statusCode).toBe(200);
    const { rules } = res.json();
    expect(rules.length).toBe(2);
    expect(rules[0].order).toBeLessThan(rules[1].order);
  });

  it('rejects JWT callers (invalid JWT → 401, valid JWT → 403)', async () => {
    // A JWT-shaped bearer (3 dot-delimited segments) but invalid → auth fails → 401
    // The important invariant: JWT identity must never get expose-rule access.
    const res = await req('GET', `/v1/${appId}/kv/_expose`, {
      token: 'header.payload.signature',
    });
    // invalid_jwt → 401 from resolveKvAuth; even if JWT were valid, expose is 403.
    expect([401, 403]).toContain(res.statusCode);
  });

  it('rejects anonymous requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/kv/_expose`,
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ── PUT _expose (bulk-replace) ─────────────────────────────────────────────────

describeDb('PUT /v1/:app_id/kv/_expose (bulk)', () => {
  it('replaces all rules in one call → 204', async () => {
    // Pre-populate two rules
    await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('old:*')}`, {
      payload: { read: 'public', write: 'deny' },
    });

    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      payload: {
        rules: [
          { pattern: 'posts:*', read: 'public', write: 'authed' },
          { pattern: 'session:*', read: 'authed', write: 'deny' },
        ],
      },
    });
    expect(res.statusCode).toBe(204);

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    const { rules } = list.json();
    // old:* must be gone; new rules present
    expect(rules.find((r: any) => r.pattern === 'old:*')).toBeUndefined();
    expect(rules.find((r: any) => r.pattern === 'posts:*')).toBeDefined();
    expect(rules.find((r: any) => r.pattern === 'session:*')).toBeDefined();
  });

  it('accepts boolean read/write (dashboard compat: true→public, false→deny)', async () => {
    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      payload: {
        rules: [{ pattern: 'flags:*', read: true, write: false }],
      },
    });
    expect(res.statusCode).toBe(204);

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    const rule = list.json().rules.find((r: any) => r.pattern === 'flags:*');
    expect(rule).toBeDefined();
    expect(rule.read).toBe('public');
    expect(rule.write).toBe('deny');
  });

  it('clears all rules when given an empty array → 204', async () => {
    await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('tmp:*')}`, {
      payload: { read: 'public', write: 'deny' },
    });

    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      payload: { rules: [] },
    });
    expect(res.statusCode).toBe(204);

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    expect(list.json().rules).toHaveLength(0);
  });

  it('returns 400 when rules field is missing', async () => {
    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      payload: { notRules: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid role value', async () => {
    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      payload: { rules: [{ pattern: 'x:*', read: 'admin', write: 'public' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req('PUT', `/v1/${appId}/kv/_expose`, {
      token: 'header.payload.signature',
      payload: { rules: [] },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ── PUT _expose/:pattern ────────────────────────────────────────────────────────

describeDb('PUT /v1/:app_id/kv/_expose/:pattern', () => {
  it('creates a new rule → 204', async () => {
    const res = await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('posts:*')}`, {
      payload: { read: 'public', write: 'authed' },
    });
    expect(res.statusCode).toBe(204);

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    const rules = list.json().rules;
    const rule = rules.find((r: any) => r.pattern === 'posts:*');
    expect(rule).toBeDefined();
    expect(rule.read).toBe('public');
    expect(rule.write).toBe('authed');
  });

  it('is idempotent — saving the same rule twice works', async () => {
    const url = `/v1/${appId}/kv/_expose/${encodeURIComponent('idem:*')}`;
    const payload = { read: 'public', write: 'deny' };
    await req('PUT', url, { payload });
    const res2 = await req('PUT', url, { payload });
    expect(res2.statusCode).toBe(204);

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    const matching = list.json().rules.filter((r: any) => r.pattern === 'idem:*');
    expect(matching.length).toBe(1);
  });

  it('returns 409 on conflict (same pattern, different roles)', async () => {
    const url = `/v1/${appId}/kv/_expose/${encodeURIComponent('conflict:*')}`;
    await req('PUT', url, { payload: { read: 'public', write: 'deny' } });
    const res2 = await req('PUT', url, { payload: { read: 'authed', write: 'deny' } });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: 'KV_EXPOSE_CONFLICT' });
  });

  it('returns 400 for invalid roles', async () => {
    const res = await req(
      'PUT',
      `/v1/${appId}/kv/_expose/${encodeURIComponent('test:*')}`,
      { payload: { read: 'admin', write: 'public' } },
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req(
      'PUT',
      `/v1/${appId}/kv/_expose/${encodeURIComponent('test:*')}`,
      { token: 'header.payload.signature', payload: { read: 'public', write: 'deny' } },
    );
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ── DELETE _expose/:pattern ─────────────────────────────────────────────────────

describeDb('DELETE /v1/:app_id/kv/_expose/:pattern', () => {
  it('deletes an existing rule → {deleted: 1}', async () => {
    await req('PUT', `/v1/${appId}/kv/_expose/${encodeURIComponent('del:*')}`, {
      payload: { read: 'public', write: 'deny' },
    });

    const del = await req('DELETE', `/v1/${appId}/kv/_expose/${encodeURIComponent('del:*')}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: 1 });

    const list = await req('GET', `/v1/${appId}/kv/_expose`);
    expect(list.json().rules.find((r: any) => r.pattern === 'del:*')).toBeUndefined();
  });

  it('returns {deleted: 0} for a non-existent pattern', async () => {
    const del = await req(
      'DELETE',
      `/v1/${appId}/kv/_expose/${encodeURIComponent('nonexistent:*')}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: 0 });
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req(
      'DELETE',
      `/v1/${appId}/kv/_expose/${encodeURIComponent('del:*')}`,
      { token: 'header.payload.signature' },
    );
    expect([401, 403]).toContain(res.statusCode);
  });
});
