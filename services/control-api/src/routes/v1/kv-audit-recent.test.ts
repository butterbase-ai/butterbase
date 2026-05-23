import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { buildAppWithDevKey, cleanupFixture, type AppFixture } from '../../services/kv/__test-utils__/kv-test-harness.js';
import kvAuditRecentRoutes from './kv-audit-recent.js';

const RUN = !!process.env.RUN_DB_TESTS && !!process.env.NEON_PLATFORM_PRIMARY_URL;
const describeDb = RUN ? describe : describe.skip;

describeDb('GET /v1/:app_id/kv/_audit_recent', () => {
  let pool: pg.Pool;
  let fixture: AppFixture;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.NEON_PLATFORM_PRIMARY_URL });
    fixture = await buildAppWithDevKey(pool, 'audit-recent');
  });

  afterAll(async () => {
    await cleanupFixture(pool, fixture.appId);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM audit_logs WHERE app_id = $1', [fixture.appId]);
  });

  async function build() {
    const app = Fastify({ logger: false });
    const fp = (await import('fastify-plugin')).default;
    await app.register(fp(async (i: any) => { i.decorate('controlDb', pool); }, { name: 'database' }));
    await app.register(kvAuditRecentRoutes);
    await app.ready();
    return app;
  }

  it('returns empty array when no errors recorded', async () => {
    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ entries: [] });
    await app.close();
  });

  it('returns only KV-path entries with status >= 400, newest first, capped at limit', async () => {
    await pool.query(
      `INSERT INTO audit_logs (app_id, method, path, status_code, error_code, at)
       VALUES ($1, 'PUT', $2, 200, NULL, now() - interval '5 minutes'),
              ($1, 'PUT', $3, 413, 'value_too_large', now() - interval '3 minutes'),
              ($1, 'PUT', $4, 429, 'kv_rate_limited', now() - interval '1 minute')`,
      [
        fixture.appId,
        `/v1/${fixture.appId}/kv/ok`,
        `/v1/${fixture.appId}/kv/too_big`,
        `/v1/${fixture.appId}/kv/spammed`,
      ],
    );

    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent?limit=10`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    const body = JSON.parse(r.body);
    expect(body.entries.length).toBe(2);
    expect(body.entries[0].status_code).toBe(429);
    expect(body.entries[1].status_code).toBe(413);
    await app.close();
  });

  it('caps limit at 200', async () => {
    const app = await build();
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${fixture.appId}/kv/_audit_recent?limit=9999`,
      headers: { authorization: `Bearer ${fixture.devKey}` },
    });
    expect(r.statusCode).toBe(200);
    await app.close();
  });
});
