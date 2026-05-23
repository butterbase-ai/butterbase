/**
 * kv-data.test.ts — Integration tests for the kv-data Fastify plugin.
 *
 * Requires:
 *   RUN_DB_TESTS=1
 *   KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390
 *   NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
 *
 * Test logic ported from kv-gateway/test/worker.test.ts, adapted for Fastify inject().
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
import kvDataRoutes from './kv-data.js';

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// Parse host/port/password from the Redis URL for direct verification.
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
  const fixture = await buildAppWithDevKey(pool, 'kv-data');
  appId = fixture.appId;
  devKey = fixture.devKey;
  baseRedisOpts = parseRedisUrl(KV_REDIS_URL_US);

  app = Fastify({ logger: false });
  app.decorate('controlDb', pool);
  await app.register(kvDataRoutes);
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

// ── Helper ─────────────────────────────────────────────────────────────────────

function req(
  method: string,
  url: string,
  opts: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const hasBody = opts.payload !== undefined;
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${devKey}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    payload: hasBody ? JSON.stringify(opts.payload) : undefined,
  });
}

// ── GET + PUT round-trip ───────────────────────────────────────────────────────

describeDb('PUT → GET round-trip', () => {
  it('stores and retrieves a value', async () => {
    const put = await req('PUT', `/v1/${appId}/kv/hello`, { payload: { value: 'world' } });
    expect(put.statusCode).toBe(204);

    const get = await req('GET', `/v1/${appId}/kv/hello`);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ value: 'world' });
  });

  it('GET missing key returns 404', async () => {
    const get = await req('GET', `/v1/${appId}/kv/missing-key`);
    expect(get.statusCode).toBe(404);
  });

  it('stores complex JSON values', async () => {
    const value = { nested: { arr: [1, 2, 3], bool: true, nil: null } };
    await req('PUT', `/v1/${appId}/kv/complex`, { payload: { value } });
    const get = await req('GET', `/v1/${appId}/kv/complex`);
    expect(get.json().value).toEqual(value);
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────────

describeDb('DELETE', () => {
  it('removes a key and returns {deleted: 1}', async () => {
    await req('PUT', `/v1/${appId}/kv/to-delete`, { payload: { value: 'x' } });
    const del = await req('DELETE', `/v1/${appId}/kv/to-delete`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: 1 });

    const get = await req('GET', `/v1/${appId}/kv/to-delete`);
    expect(get.statusCode).toBe(404);
  });

  it('returns {deleted: 0} for a missing key', async () => {
    const del = await req('DELETE', `/v1/${appId}/kv/totally-absent-key`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: 0 });
  });
});

// ── Auth ───────────────────────────────────────────────────────────────────────

describeDb('Auth', () => {
  it('rejects with 403 when no Authorization header (anon + no expose rule)', async () => {
    // No expose rules set, so anon is rejected
    const r = await app.inject({ method: 'GET', url: `/v1/${appId}/kv/x` });
    // anon with no expose rules → unauthorized or forbidden
    expect([401, 403]).toContain(r.statusCode);
  });

  it('rejects with 4xx for an invalid API key', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/kv/hello`,
      headers: { authorization: 'Bearer bb_live_invalid_key_does_not_exist' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects invalid key characters with 400', async () => {
    const r = await req('PUT', `/v1/${appId}/kv/has space`, { payload: { value: 'x' } });
    expect(r.statusCode).toBe(400);
  });
});

// ── incr ───────────────────────────────────────────────────────────────────────

describeDb('incr', () => {
  it('increments by default 1', async () => {
    const res = await req('POST', `/v1/${appId}/kv/counter-incr/incr`, { payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ value: 1 });
  });

  it('increments by custom amount', async () => {
    // Start at 0, then increment by 5
    await req('POST', `/v1/${appId}/kv/counter-incr2/incr`, { payload: {} });
    const res = await req('POST', `/v1/${appId}/kv/counter-incr2/incr`, { payload: { by: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(6);
  });

  it('rejects non-integer by with 400', async () => {
    const res = await req('POST', `/v1/${appId}/kv/counter/incr`, { payload: { by: 1.5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request', message: 'by must be an integer' });
  });
});

// ── decr ───────────────────────────────────────────────────────────────────────

describeDb('decr', () => {
  it('decrements by default 1', async () => {
    // Start at 0, incr to 1, decr back to 0
    await req('POST', `/v1/${appId}/kv/counter-decr/incr`, { payload: {} });
    const res = await req('POST', `/v1/${appId}/kv/counter-decr/decr`, { payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ value: 0 });
  });

  it('decrements by custom amount', async () => {
    const res = await req('POST', `/v1/${appId}/kv/counter-decr2/decr`, { payload: { by: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe(-3);
  });

  it('rejects non-integer by with 400', async () => {
    const res = await req('POST', `/v1/${appId}/kv/counter/decr`, { payload: { by: 1.5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request', message: 'by must be an integer' });
  });
});

// ── setnx ──────────────────────────────────────────────────────────────────────

describeDb('setnx', () => {
  it('writes when key absent → 201 {wrote: true}', async () => {
    const res = await req('POST', `/v1/${appId}/kv/setnx-key/setnx`, {
      payload: { value: 'initial' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ wrote: true });
  });

  it('does not overwrite existing key → 200 {wrote: false}', async () => {
    await req('POST', `/v1/${appId}/kv/setnx-key2/setnx`, { payload: { value: 'initial' } });
    const res = await req('POST', `/v1/${appId}/kv/setnx-key2/setnx`, {
      payload: { value: 'overwrite' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wrote: false });

    const get = await req('GET', `/v1/${appId}/kv/setnx-key2`);
    expect(get.json().value).toBe('initial');
  });

  it('ephemeral:true lands in DB 1, not DB 0', async () => {
    const res = await req('POST', `/v1/${appId}/kv/setnx-eph/setnx`, {
      payload: { value: 'eph', ephemeral: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ wrote: true });

    const c0 = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const inDb0 = await c0.get(`{${appId}}:u:setnx-eph`);
    await c0.close();
    expect(inDb0).toBeNull();

    const c1 = await RedisClient.connect({ ...baseRedisOpts, db: 1 });
    const inDb1 = await c1.get(`{${appId}}:u:setnx-eph`);
    await c1.close();
    expect(inDb1).not.toBeNull();
    expect(JSON.parse(inDb1!)).toBe('eph');
  });

  it('explicit ttl applies a TTL', async () => {
    const res = await req('POST', `/v1/${appId}/kv/setnx-ttl/setnx`, {
      payload: { value: 'x', ttl: 30 },
    });
    expect(res.statusCode).toBe(201);
    const c = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const t = await c.ttl(`{${appId}}:u:setnx-ttl`);
    await c.close();
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(30);
  });
});

// ── cas ────────────────────────────────────────────────────────────────────────

describeDb('cas', () => {
  it('swaps when expected matches current value', async () => {
    await req('PUT', `/v1/${appId}/kv/cas-key`, { payload: { value: 'v1' } });
    const res = await req('POST', `/v1/${appId}/kv/cas-key/cas`, {
      payload: { expected: 'v1', next: 'v2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ swapped: true });

    const get = await req('GET', `/v1/${appId}/kv/cas-key`);
    expect(get.json().value).toBe('v2');
  });

  it('does not swap when expected does not match', async () => {
    await req('PUT', `/v1/${appId}/kv/cas-key2`, { payload: { value: 'current' } });
    const res = await req('POST', `/v1/${appId}/kv/cas-key2/cas`, {
      payload: { expected: 'stale', next: 'new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ swapped: false });
  });

  it('swaps from null sentinel when key absent', async () => {
    const res = await req('POST', `/v1/${appId}/kv/cas-new/cas`, {
      payload: { expected: null, next: 'created' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ swapped: true });
    const get = await req('GET', `/v1/${appId}/kv/cas-new`);
    expect(get.json().value).toBe('created');
  });

  it('rejects missing expected or next with 400', async () => {
    const res = await req('POST', `/v1/${appId}/kv/cas-key/cas`, {
      payload: { expected: 'v1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── expire ─────────────────────────────────────────────────────────────────────

describeDb('expire', () => {
  it('sets TTL on an existing key', async () => {
    await req('PUT', `/v1/${appId}/kv/expire-key`, {
      payload: { value: 'x', ttl: null },
    });
    const res = await req('POST', `/v1/${appId}/kv/expire-key/expire`, {
      payload: { ttl: 60 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
  });

  it('removes TTL when null is passed (PERSIST)', async () => {
    await req('PUT', `/v1/${appId}/kv/persist-key`, { payload: { value: 'x', ttl: 60 } });
    const res = await req('POST', `/v1/${appId}/kv/persist-key/expire`, {
      payload: { ttl: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
  });

  it('rejects missing ttl with 400', async () => {
    const res = await req('POST', `/v1/${appId}/kv/expire-key/expire`, { payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });
});

// ── ttl ────────────────────────────────────────────────────────────────────────

describeDb('GET /ttl', () => {
  it('returns ttl for a key with TTL set', async () => {
    await req('PUT', `/v1/${appId}/kv/ttl-key`, { payload: { value: 'x', ttl: 120 } });
    const res = await req('GET', `/v1/${appId}/kv/ttl-key/ttl`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.ttl).toBe('number');
    expect(body.ttl).toBeGreaterThan(0);
    expect(body.ttl).toBeLessThanOrEqual(120);
  });

  it('returns null for a key without TTL', async () => {
    await req('PUT', `/v1/${appId}/kv/ttl-persist`, { payload: { value: 'x', ttl: null } });
    const res = await req('GET', `/v1/${appId}/kv/ttl-persist/ttl`);
    expect(res.statusCode).toBe(200);
    expect(res.json().ttl).toBeNull();
  });

  it('returns 404 for a missing key', async () => {
    const res = await req('GET', `/v1/${appId}/kv/ttl-missing/ttl`);
    expect(res.statusCode).toBe(404);
  });
});

// ── exists ─────────────────────────────────────────────────────────────────────

describeDb('GET /exists', () => {
  it('returns {exists: true} for an existing key', async () => {
    await req('PUT', `/v1/${appId}/kv/exists-key`, { payload: { value: 'x' } });
    const res = await req('GET', `/v1/${appId}/kv/exists-key/exists`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true });
  });

  it('returns {exists: false} for a missing key', async () => {
    const res = await req('GET', `/v1/${appId}/kv/exists-missing/exists`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: false });
  });
});

// ── ephemeral routing (DB 0 / DB 1) ──────────────────────────────────────────

describeDb('ephemeral routing', () => {
  it('ephemeral:true PUT stores in DB 1, durable-first GET finds it', async () => {
    await req('PUT', `/v1/${appId}/kv/eph-key`, {
      payload: { value: 'ephemeral-value', ephemeral: true },
    });

    const c0 = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const inDb0 = await c0.get(`{${appId}}:u:eph-key`);
    await c0.close();
    expect(inDb0).toBeNull();

    const get = await req('GET', `/v1/${appId}/kv/eph-key`);
    expect(get.statusCode).toBe(200);
    expect(get.json().value).toBe('ephemeral-value');
  });

  it('switching durable → ephemeral cleans up DB 0', async () => {
    // Write durable first
    await req('PUT', `/v1/${appId}/kv/switch-key`, { payload: { value: 'durable' } });
    // Overwrite with ephemeral
    await req('PUT', `/v1/${appId}/kv/switch-key`, {
      payload: { value: 'ephemeral', ephemeral: true },
    });

    const c0 = await RedisClient.connect({ ...baseRedisOpts, db: 0 });
    const inDb0 = await c0.get(`{${appId}}:u:switch-key`);
    await c0.close();
    expect(inDb0).toBeNull(); // Cross-DB cleanup must have removed the old durable copy
  });
});

// ── Slash-in-key (wildcard route) ─────────────────────────────────────────────

describeDb('slash-in-key (wildcard route)', () => {
  it('GET /v1/:app/kv/session/abc-123 returns not_found (not route-not-found) when key missing', async () => {
    const res = await req('GET', `/v1/${appId}/kv/session/abc-123`);
    expect(res.statusCode).toBe(404);
    // Must be our {error: 'not_found'} shape, NOT Fastify's route-not-found shape.
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('PUT then GET with literal slash in key round-trips correctly', async () => {
    const put = await req('PUT', `/v1/${appId}/kv/session/abc-123`, {
      payload: { value: { u: 'alice' } },
    });
    expect(put.statusCode).toBe(204);

    const get = await req('GET', `/v1/${appId}/kv/session/abc-123`);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ value: { u: 'alice' } });
  });
});

// ── _batch ─────────────────────────────────────────────────────────────────────

describeDb('_batch', () => {
  it('set → get → del round-trip', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_batch`, {
      payload: {
        ops: [
          { op: 'set', key: 'batch-a', value: 'alpha' },
          { op: 'set', key: 'batch-b', value: 42 },
          { op: 'get', key: 'batch-a' },
          { op: 'del', key: 'batch-b' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0]).toEqual({ ok: true });
    expect(body.results[1]).toEqual({ ok: true });
    expect(body.results[2]).toEqual({ value: 'alpha' });
    expect(body.results[3]).toMatchObject({ deleted: expect.any(Number) });
  });

  it('returns error for invalid op', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_batch`, {
      payload: { ops: [{ op: 'noop', key: 'x' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toEqual({ error: 'invalid op' });
  });

  it('returns error for invalid key', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_batch`, {
      payload: { ops: [{ op: 'get', key: '_reserved' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toEqual({ error: 'key_invalid' });
  });

  it('returns 400 when ops is not an array', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_batch`, { payload: { ops: 'bad' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('returns 400 when ops exceeds BATCH_MAX_OPS', async () => {
    const ops = Array.from({ length: 101 }, (_, i) => ({ op: 'get', key: `k${i}` }));
    const res = await req('POST', `/v1/${appId}/kv/_batch`, { payload: { ops } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('get on missing key returns {value: null}', async () => {
    const res = await req('POST', `/v1/${appId}/kv/_batch`, {
      payload: { ops: [{ op: 'get', key: 'batch-missing' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toEqual({ value: null });
  });
});
