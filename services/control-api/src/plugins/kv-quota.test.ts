/**
 * kv-quota.test.ts — Integration tests for the kv-quota preHandler plugin.
 *
 * Requires:
 *   RUN_DB_TESTS=1
 *   KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390
 *   NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
 *
 * Test cases:
 *   1. Rate limit: 50 writes on free tier (cap=50/s); 51st gets 429
 *   2. Credits exhausted: balance=0 → 402
 *   3. Value too large: PUT >256 KB → 413
 *   4. Storage cap: pre-seed bytes counter near limit → 507
 *   5. Successful write: counter incremented; kvAccount fires correctly
 *   6. Successful read after write: storage counter unchanged
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import {
  RUN_DB_TESTS,
  PLATFORM_URL,
  KV_REDIS_URL_US,
  buildAppWithDevKey,
  resetKvScope,
  cleanupFixture,
  type AppFixture,
} from '../services/kv/__test-utils__/kv-test-harness.js';
import { RedisClient, wrap } from '../services/kv/redis-client.js';
import { getStorageBytes, incBytes } from '../services/kv/storage-counter.js';
import { getKeys, resetKeysCounter } from '../services/kv/keys-counter.js';
import { setKvBlock, clearKvBlock } from '../services/kv/migration-sentinel.js';
import kvQuotaPlugin from './kv-quota.js';
import kvDataRoutes from '../routes/v1/kv-data.js';
import { databasePlugin } from './database.js';

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379, password: u.password };
}

let pool: pg.Pool;
let fixture: AppFixture;
let appId: string;
let devKey: string;
let redis: Redis;

// Build a fresh Fastify app with both the quota plugin + data routes registered.
// kvAccount decoration requires kv-quota to be registered first.
// We bypass the full plugin stack by decorating controlDb directly and using
// the databasePlugin to register the 'database' name so fp dep-checks pass.
async function buildTestApp(db: pg.Pool) {
  const app = Fastify({ logger: false });

  // Register a shim plugin named 'database' so fp dependency checks pass.
  // fp() registers the plugin name in the instance's plugin-name registry.
  const fp = (await import('fastify-plugin')).default;
  const dbShim = fp(async (instance: any) => {
    instance.decorate('controlDb', db);
  }, { name: 'database' });
  await app.register(dbShim);

  await app.register(kvQuotaPlugin);
  await app.register(kvDataRoutes);
  await app.ready();
  return app;
}

function req(
  app: ReturnType<typeof Fastify>,
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

// Flush all rate-limit and meta keys for an app
async function resetKvMeta(appId: string): Promise<void> {
  const patterns = [
    `{${appId}}:_meta:*`,
    `kv:owner:${appId}`,
    `app:${appId}:limits`,
  ];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      if (keys.length > 0) await redis.unlink(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}

// Set the bytes counter directly for storage cap tests
async function setSeedBytes(appId: string, bytes: number): Promise<void> {
  await redis.set(`{${appId}}:_meta:bytes`, String(bytes));
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  process.env.KV_REDIS_URL_US = KV_REDIS_URL_US;

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  fixture = await buildAppWithDevKey(pool, 'kv-quota');
  appId = fixture.appId;
  devKey = fixture.devKey;

  redis = new Redis(KV_REDIS_URL_US, { lazyConnect: false, maxRetriesPerRequest: 2 });
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await redis.quit();
  await cleanupFixture(pool, appId);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  await resetKvScope(appId);
  await resetKvMeta(appId);
  // Reset keys counter
  const kvR = wrap(redis);
  await resetKeysCounter(kvR, appId);
  // Restore credits balance to a positive value (in case a test zeroed it)
  await pool.query(
    `UPDATE platform_users SET monthly_allowance_usd = 10, credits_usd = 0 WHERE id = $1`,
    [fixture.userId],
  );
});

// ── Test cases ─────────────────────────────────────────────────────────────────

describeDb('kv-quota plugin', () => {

  // ── Rate limit ──────────────────────────────────────────────────────────────

  it('allows writes up to the rate limit and blocks the next one', async () => {
    const app = await buildTestApp(pool);
    try {
      // Free-tier rate limit is 50 ops/sec.
      // We pre-seed the rate bucket to just under the limit.
      const bucket = Math.floor(Date.now() / 1000);
      const rateKey = `{${appId}}:_meta:rate:${bucket}`;
      await redis.set(rateKey, '50');
      await redis.expire(rateKey, 2);

      // This write should be blocked (50 already consumed + 1 new = 51 > 50)
      const blocked = await req(app, 'PUT', `/v1/${appId}/kv/rl-test`, {
        payload: { value: 'hi' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: 'kv_rate_limited' });
      expect(blocked.headers['retry-after']).toBe('1');
    } finally {
      await app.close();
    }
  });

  it('allows writes below the rate limit', async () => {
    const app = await buildTestApp(pool);
    try {
      const put = await req(app, 'PUT', `/v1/${appId}/kv/allowed`, {
        payload: { value: 'ok' },
      });
      expect(put.statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });

  // ── Credits exhausted ───────────────────────────────────────────────────────
  //
  // KV ops currently have a per-op cost of 0 (see creditCostForOp), so the
  // credits-balance gate is skipped. A zero-balance owner can still PUT/GET.
  // If non-zero costs are ever restored, swap this test back to asserting 402.

  it('allows ops at zero balance because KV ops cost 0 credits', async () => {
    const app = await buildTestApp(pool);
    try {
      await pool.query(
        `UPDATE platform_users SET monthly_allowance_usd = 0, credits_usd = 0 WHERE id = $1`,
        [fixture.userId],
      );

      const r = await req(app, 'PUT', `/v1/${appId}/kv/credit-test`, {
        payload: { value: 'x' },
      });
      expect(r.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // ── Value too large ─────────────────────────────────────────────────────────

  it('returns 413 for a value larger than maxValueBytes', async () => {
    const app = await buildTestApp(pool);
    try {
      // Free-tier maxValueBytes = 256 * 1024 = 262144 bytes
      // Create a value that exceeds this when JSON-encoded
      const bigValue = 'x'.repeat(264 * 1024);
      const r = await req(app, 'PUT', `/v1/${appId}/kv/big-val`, {
        payload: { value: bigValue },
      });
      expect(r.statusCode).toBe(413);
      expect(r.json()).toMatchObject({ error: 'value_too_large' });
    } finally {
      await app.close();
    }
  });

  // ── Storage cap ─────────────────────────────────────────────────────────────

  it('returns 507 when the storage cap would be exceeded', async () => {
    const app = await buildTestApp(pool);
    try {
      // Free tier cap = 10 MiB = 10 * 1024 * 1024 bytes
      const cap = 10 * 1024 * 1024;
      // Seed the counter to cap - 100 bytes, then try to write 200 bytes
      await setSeedBytes(appId, cap - 100);

      const value = 'y'.repeat(200); // ~202 bytes JSON-encoded (with quotes)
      const r = await req(app, 'PUT', `/v1/${appId}/kv/storage-cap-test`, {
        payload: { value },
      });
      expect(r.statusCode).toBe(507);
      expect(r.json()).toMatchObject({ error: 'kv_storage_full' });
    } finally {
      await app.close();
    }
  });

  // ── Successful write: storage counter updated ────────────────────────────────

  it('updates the storage byte counter after a successful write', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);
      const beforeBytes = await getStorageBytes(kvR, appId);

      const value = 'hello-world';
      const put = await req(app, 'PUT', `/v1/${appId}/kv/acc-test`, {
        payload: { value },
      });
      expect(put.statusCode).toBe(204);

      // Give the fire-and-forget incBytes call time to complete
      await new Promise((r) => setTimeout(r, 50));

      const afterBytes = await getStorageBytes(kvR, appId);
      // The encoded value "hello-world" is 13 bytes (JSON string with quotes)
      const expectedEncoded = JSON.stringify(value);
      const expectedDelta = Buffer.byteLength(expectedEncoded);
      // Since key didn't exist before, delta = new size
      expect(afterBytes - beforeBytes).toBe(expectedDelta);
    } finally {
      await app.close();
    }
  });

  // ── Successful read: storage counter unchanged ──────────────────────────────

  it('does not change the storage byte counter on a read', async () => {
    const app = await buildTestApp(pool);
    try {
      // Seed a value first
      await req(app, 'PUT', `/v1/${appId}/kv/read-acc-test`, {
        payload: { value: 'some-value' },
      });
      await new Promise((r) => setTimeout(r, 50));

      const kvR = wrap(redis);
      const beforeBytes = await getStorageBytes(kvR, appId);

      const get = await req(app, 'GET', `/v1/${appId}/kv/read-acc-test`);
      expect(get.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const afterBytes = await getStorageBytes(kvR, appId);
      expect(afterBytes).toBe(beforeBytes);
    } finally {
      await app.close();
    }
  });

  // ── Overwrite: delta is net change ──────────────────────────────────────────

  it('accounts only the net delta on overwrite', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);

      // First write
      await req(app, 'PUT', `/v1/${appId}/kv/overwrite-test`, {
        payload: { value: 'ab' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const afterFirstWrite = await getStorageBytes(kvR, appId);

      // Second write with a larger value
      await req(app, 'PUT', `/v1/${appId}/kv/overwrite-test`, {
        payload: { value: 'abcdefgh' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const afterSecondWrite = await getStorageBytes(kvR, appId);

      const firstEncoded = JSON.stringify('ab');
      const secondEncoded = JSON.stringify('abcdefgh');
      const expectedDelta = Buffer.byteLength(secondEncoded) - Buffer.byteLength(firstEncoded);
      expect(afterSecondWrite - afterFirstWrite).toBe(expectedDelta);
    } finally {
      await app.close();
    }
  });

  // ── Delete: storage counter decrements ──────────────────────────────────────

  it('decrements the storage byte counter on delete', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);
      const value = 'to-be-deleted';
      const encoded = JSON.stringify(value);

      await req(app, 'PUT', `/v1/${appId}/kv/del-acc-test`, {
        payload: { value },
      });
      await new Promise((r) => setTimeout(r, 50));
      const beforeDel = await getStorageBytes(kvR, appId);

      await req(app, 'DELETE', `/v1/${appId}/kv/del-acc-test`);
      await new Promise((r) => setTimeout(r, 50));
      const afterDel = await getStorageBytes(kvR, appId);

      expect(beforeDel - afterDel).toBe(Buffer.byteLength(encoded));
    } finally {
      await app.close();
    }
  });

  // ── Key count: increments on new key ────────────────────────────────────

  it('increments the key counter when creating a new key', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);
      const beforeKeys = await getKeys(kvR, appId);

      const put = await req(app, 'PUT', `/v1/${appId}/kv/key-count-test`, {
        payload: { value: 'hello' },
      });
      expect(put.statusCode).toBe(204);
      await new Promise((r) => setTimeout(r, 50));

      const afterKeys = await getKeys(kvR, appId);
      expect(afterKeys - beforeKeys).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ── Key count: decrements on delete ────────────────────────────────────

  it('decrements the key counter when deleting a key', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);

      // Create a key first
      await req(app, 'PUT', `/v1/${appId}/kv/key-del-test`, {
        payload: { value: 'present' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const beforeDelete = await getKeys(kvR, appId);

      // Delete it
      const del = await req(app, 'DELETE', `/v1/${appId}/kv/key-del-test`);
      expect(del.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const afterDelete = await getKeys(kvR, appId);
      expect(beforeDelete - afterDelete).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ── Key count: unchanged on overwrite ────────────────────────────────────

  it('does not change the key counter on overwrite', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);

      // Create a key
      await req(app, 'PUT', `/v1/${appId}/kv/key-overwrite-test`, {
        payload: { value: 'first' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const afterCreate = await getKeys(kvR, appId);

      // Overwrite it
      await req(app, 'PUT', `/v1/${appId}/kv/key-overwrite-test`, {
        payload: { value: 'second' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const afterOverwrite = await getKeys(kvR, appId);

      expect(afterOverwrite).toBe(afterCreate);
    } finally {
      await app.close();
    }
  });

  // ── Key count: batch operations ────────────────────────────────────────

  it('handles batch operations that mix creates, deletes, and updates', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);

      // Seed one key to delete
      await req(app, 'PUT', `/v1/${appId}/kv/batch-del-key`, {
        payload: { value: 'will-delete' },
      });
      await new Promise((r) => setTimeout(r, 50));
      const beforeBatch = await getKeys(kvR, appId);

      // Batch: create 2 new keys, delete 1 existing
      const batch = await req(app, 'POST', `/v1/${appId}/kv/_batch`, {
        payload: {
          ops: [
            { op: 'set', key: 'batch-new-1', value: 'val1' },
            { op: 'set', key: 'batch-new-2', value: 'val2' },
            { op: 'del', key: 'batch-del-key' },
          ],
        },
      });
      expect(batch.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const afterBatch = await getKeys(kvR, appId);
      // Net: +2 (new) -1 (deleted) = +1
      expect(afterBatch - beforeBatch).toBe(1);
    } finally {
      await app.close();
    }
  });

});

// ── Migration sentinel tests ────────────────────────────────────────────────────

describeDb('kv-quota migration sentinel', () => {
  it('returns 503 kv_migrating on writes when the sentinel is set', async () => {
    const app = await buildTestApp(pool);
    try {
      const kvR = wrap(redis);
      await setKvBlock(kvR, appId);
      try {
        const r = await req(app, 'PUT', `/v1/${appId}/kv/sentinel-write-test`, {
          payload: { value: 'blocked' },
        });
        expect(r.statusCode).toBe(503);
        expect(r.json()).toMatchObject({ error: 'kv_migrating', app_id: appId });
        expect(r.headers['retry-after']).toBe('5');
      } finally {
        await clearKvBlock(kvR, appId);
      }
    } finally {
      await app.close();
    }
  });

  it('reads still pass while the sentinel is set', async () => {
    const app = await buildTestApp(pool);
    try {
      // Seed a value to read back
      await req(app, 'PUT', `/v1/${appId}/kv/sentinel-read-test`, {
        payload: { value: 'present' },
      });

      const kvR = wrap(redis);
      await setKvBlock(kvR, appId);
      try {
        const r = await req(app, 'GET', `/v1/${appId}/kv/sentinel-read-test`);
        expect(r.statusCode).toBe(200);
      } finally {
        await clearKvBlock(kvR, appId);
      }
    } finally {
      await app.close();
    }
  });

  it('sentinel check runs before rate-limit (503 wins over 429)', async () => {
    const app = await buildTestApp(pool);
    try {
      // Exhaust the rate budget
      const bucket = Math.floor(Date.now() / 1000);
      const rateKey = `{${appId}}:_meta:rate:${bucket}`;
      await redis.set(rateKey, '50');
      await redis.expire(rateKey, 2);

      const kvR = wrap(redis);
      await setKvBlock(kvR, appId);
      try {
        const r = await req(app, 'PUT', `/v1/${appId}/kv/sentinel-vs-rl`, {
          payload: { value: 'x' },
        });
        // Sentinel fires first, so we get 503 not 429
        expect(r.statusCode).toBe(503);
        expect(r.json()).toMatchObject({ error: 'kv_migrating' });
      } finally {
        await clearKvBlock(kvR, appId);
      }
    } finally {
      await app.close();
    }
  });
});

// ── Unit tests for pure helpers ────────────────────────────────────────────────

describe('kv-quota helpers', () => {
  it('sizeOfBody returns 0 for empty body', async () => {
    const { sizeOfBody } = await import('./kv-quota.js');
    expect(sizeOfBody(null)).toBe(0);
    expect(sizeOfBody(undefined)).toBe(0);
    expect(sizeOfBody({})).toBe(0);
  });

  it('sizeOfBody measures single value', async () => {
    const { sizeOfBody } = await import('./kv-quota.js');
    const value = 'hello';
    const expected = Buffer.byteLength(JSON.stringify(value));
    expect(sizeOfBody({ value })).toBe(expected);
  });

  it('sizeOfBody sums batch op values', async () => {
    const { sizeOfBody } = await import('./kv-quota.js');
    const ops = [
      { op: 'set', key: 'a', value: 'hello' },
      { op: 'set', key: 'b', value: 'world!' },
    ];
    const expected =
      Buffer.byteLength(JSON.stringify('hello')) +
      Buffer.byteLength(JSON.stringify('world!'));
    expect(sizeOfBody({ ops })).toBe(expected);
  });

  it('parseActionFromUrl extracts known actions', async () => {
    const { parseActionFromUrl } = await import('./kv-quota.js');
    expect(parseActionFromUrl('/v1/app/kv/foo/ttl')).toBe('ttl');
    expect(parseActionFromUrl('/v1/app/kv/foo/incr')).toBe('incr');
    expect(parseActionFromUrl('/v1/app/kv/foo')).toBe(null);
    expect(parseActionFromUrl('/v1/app/kv/_batch')).toBe('_batch');
    expect(parseActionFromUrl('/v1/app/kv/foo/unknown')).toBe(null);
  });
});
