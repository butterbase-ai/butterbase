/**
 * kv-admin.test.ts — Integration tests for the kv-admin Fastify plugin.
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
import { RedisClient } from '../../services/kv/redis-client.js';
import kvAdminRoutes from './kv-admin.js';

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379, password: u.password };
}

let pool: pg.Pool;
let app: ReturnType<typeof Fastify>;
let appId: string;
let devKey: string;
let baseRedisOpts: { host: string; port: number; password: string };

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  process.env.KV_REDIS_URL_US = KV_REDIS_URL_US;

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const fixture = await buildAppWithDevKey(pool, 'kv-admin');
  appId = fixture.appId;
  devKey = fixture.devKey;
  baseRedisOpts = parseRedisUrl(KV_REDIS_URL_US);

  app = Fastify({ logger: false });
  app.decorate('controlDb', pool);
  await app.register(kvAdminRoutes);
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
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    payload: opts.payload !== undefined ? JSON.stringify(opts.payload) : undefined,
  });
}

// Helper: seed keys directly via Redis
async function seedKey(key: string, value: string, db = 0): Promise<void> {
  const c = await RedisClient.connect({ ...baseRedisOpts, db });
  await c.set(`{${appId}}:u:${key}`, JSON.stringify(value));
  await c.close();
}

// ── _scan ───────────────────────────────────────────────────────────────────────

describeDb('GET /v1/:app_id/kv/_scan', () => {
  it('returns empty keys when no data', async () => {
    const res = await req('GET', `/v1/${appId}/kv/_scan`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ keys: [], cursor: '0' });
  });

  it('lists seeded keys', async () => {
    await seedKey('scan-a', 'v1');
    await seedKey('scan-b', 'v2');

    const res = await req('GET', `/v1/${appId}/kv/_scan`);
    expect(res.statusCode).toBe(200);
    const { keys } = res.json();
    expect(keys).toContain('scan-a');
    expect(keys).toContain('scan-b');
  });

  it('filters by prefix', async () => {
    await seedKey('prefix-a', 'v1');
    await seedKey('prefix-b', 'v2');
    await seedKey('other', 'v3');

    const res = await req('GET', `/v1/${appId}/kv/_scan?prefix=prefix-`);
    expect(res.statusCode).toBe(200);
    const { keys } = res.json();
    expect(keys).toContain('prefix-a');
    expect(keys).toContain('prefix-b');
    expect(keys).not.toContain('other');
  });

  it('respects limit', async () => {
    await seedKey('lim-a', 'v1');
    await seedKey('lim-b', 'v2');
    await seedKey('lim-c', 'v3');

    const res = await req('GET', `/v1/${appId}/kv/_scan?prefix=lim-&limit=2`);
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.length).toBeLessThanOrEqual(2);
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req('GET', `/v1/${appId}/kv/_scan`, {
      token: 'header.payload.signature',
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('rejects anonymous requests', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/${appId}/kv/_scan` });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('unions keys from both DB 0 and DB 1', async () => {
    await seedKey('db0-key', 'durable', 0);
    await seedKey('db1-key', 'ephemeral', 1);

    const res = await req('GET', `/v1/${appId}/kv/_scan`);
    expect(res.statusCode).toBe(200);
    const { keys } = res.json();
    expect(keys).toContain('db0-key');
    expect(keys).toContain('db1-key');
  });
});

// ── _stats ──────────────────────────────────────────────────────────────────────

describeDb('GET /v1/:app_id/kv/_stats', () => {
  it('returns stats shape with expected fields', async () => {
    await seedKey('stats-key', 'value');

    const res = await req('GET', `/v1/${appId}/kv/_stats`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.keys_total).toBe('number');
    expect(body.keys_total).toBeGreaterThanOrEqual(1);
    expect(typeof body.bytes_used).toBe('number');
    expect(body.ops_per_sec).toBeNull();
  });

  it('returns zeros for empty app', async () => {
    const res = await req('GET', `/v1/${appId}/kv/_stats`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys_total).toBe(0);
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req('GET', `/v1/${appId}/kv/_stats`, {
      token: 'header.payload.signature',
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ── _flush ──────────────────────────────────────────────────────────────────────

describeDb('POST /v1/:app_id/kv/_flush', () => {
  it('requires confirm:true — returns 400 otherwise', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_flush`, { payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'confirm_required' });
  });

  it('flushes all user keys and returns {deleted: N}', async () => {
    await seedKey('flush-a', 'v1');
    await seedKey('flush-b', 'v2');

    const res = await req('POST', `/v1/${appId}/kv/_flush`, {
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.deleted).toBe('number');
    expect(body.deleted).toBeGreaterThanOrEqual(2);

    // Verify keys are gone
    const c = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const v = await c.get(`{${appId}}:u:flush-a`);
    await c.close();
    expect(v).toBeNull();
  });

  it('preserves expose rules by default (include_config not set)', async () => {
    // Seed an expose rule manually
    const c = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    await c.hset(`{${appId}}:_meta:expose`, 'test:*', JSON.stringify({ read: 'public', write: 'deny', order: 0 }));
    await c.close();

    await seedKey('user-data', 'val');
    await req('POST', `/v1/${appId}/kv/_flush`, { payload: { confirm: true } });

    const c2 = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const raw = await c2.hgetall(`{${appId}}:_meta:expose`);
    await c2.close();
    // Expose rule should still be there
    expect(Object.keys(raw).length).toBeGreaterThan(0);
  });

  it('deletes expose rules when include_config:true', async () => {
    const c = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    await c.hset(`{${appId}}:_meta:expose`, 'test:*', JSON.stringify({ read: 'public', write: 'deny', order: 0 }));
    await c.close();

    await req('POST', `/v1/${appId}/kv/_flush`, {
      payload: { confirm: true, include_config: true },
    });

    const c2 = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const raw = await c2.hgetall(`{${appId}}:_meta:expose`);
    await c2.close();
    expect(Object.keys(raw).length).toBe(0);
  });

  it('rejects JWT callers (invalid JWT → 401; valid JWT → 403)', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_flush`, {
      token: 'header.payload.signature',
      payload: { confirm: true },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
