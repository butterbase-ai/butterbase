import { PassThrough, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { executeRestoreKv } from './step-restore-kv.js';
import { serializeRecord, type KvDumpRecord } from './kv-dump-format.js';
import { RedisClient } from '../kv/redis-client.js';

const makeCtx = (extra: Record<string, any> = {}): any => ({
  controlPool: { query: vi.fn().mockResolvedValue({ rowCount: 1 }) },
  runtimePoolFor: vi.fn(),
  redisFor: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...extra,
});

const makeMigration = (overrides: Record<string, any> = {}): any => ({
  id: 'mig-restore-1',
  app_id: 'app-kv',
  user_id: 'u',
  source_region: 'us',
  dest_region: 'eu',
  current_step: 'restoring_kv',
  dest_resources: {},
  ...overrides,
});

/** Build a gzip-compressed JSONL stream from KvDumpRecord[] */
function buildGzipStream(records: KvDumpRecord[]): Readable {
  const pt = new PassThrough();
  const gz = createGzip();
  pt.pipe(gz);
  for (const rec of records) {
    pt.write(serializeRecord(rec) + '\n');
  }
  pt.end();
  return gz;
}

// ---------------------------------------------------------------------------
// Unit tests (no real Redis / Postgres needed)
// ---------------------------------------------------------------------------

describe('executeRestoreKv', () => {
  it('idempotent — early-return when kv_restored_at already set, no download or DB call', async () => {
    const downloadKvDump = vi.fn();
    const ctx = makeCtx({ downloadKvDump });
    const m = makeMigration({
      dest_resources: { kv_restored_at: '2026-01-01T00:00:00Z', kv_dump_object_key: 'some/key' },
    });

    const res = await executeRestoreKv(ctx, m);

    expect(res.next).toBe('copying_blobs');
    expect(res.patch).toEqual({});
    expect(downloadKvDump).not.toHaveBeenCalled();
    expect(ctx.controlPool.query).not.toHaveBeenCalled();
  });

  it('throws when kv_dump_object_key is missing', async () => {
    const ctx = makeCtx();
    const m = makeMigration({ dest_resources: {} });

    await expect(executeRestoreKv(ctx, m)).rejects.toThrow(/missing kv_dump_object_key/);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real Redis required
// ---------------------------------------------------------------------------

const hasRedis = !!(process.env.KV_REDIS_URL_US && process.env.KV_REDIS_URL_EU);

function kvBaseOptsFromUrl(url: string): Omit<import('../kv/redis-client.js').RedisClientOptions, 'db'> {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

describe.skipIf(!hasRedis)('executeRestoreKv — real Redis integration', () => {
  const usUrl = process.env.KV_REDIS_URL_US ?? '';
  const euUrl = process.env.KV_REDIS_URL_EU ?? '';

  it('non-empty dest aborts with non_empty_dest error', async () => {
    const { randomUUID } = await import('node:crypto');
    const appId = `kv-restore-test-${randomUUID()}`;

    const euBase = kvBaseOptsFromUrl(euUrl);

    // Seed a non-meta key in EU dest DB 0 to simulate a dirty dest
    const eu0 = await RedisClient.connect({ ...euBase, db: 0 });
    await eu0.set(`{${appId}}:u:stale`, 'some-value');
    await eu0.close();

    const kvBaseOptsForRegion = (region: string) => {
      if (region === 'us') return kvBaseOptsFromUrl(usUrl);
      if (region === 'eu') return kvBaseOptsFromUrl(euUrl);
      throw new Error(`unknown region ${region}`);
    };

    const downloadKvDump = vi.fn();
    const ctx = makeCtx({ downloadKvDump, kvBaseOptsForRegion });
    const m = makeMigration({
      app_id: appId,
      dest_resources: { kv_dump_object_key: 'some/key' },
    });

    try {
      await expect(executeRestoreKv(ctx, m)).rejects.toThrow(/non_empty_dest/);
      // downloadKvDump should never be called when dest is dirty
      expect(downloadKvDump).not.toHaveBeenCalled();
    } finally {
      // Cleanup
      const cleanup = await RedisClient.connect({ ...euBase, db: 0 });
      await cleanup.del([`{${appId}}:u:stale`]);
      await cleanup.close();
    }
  });

  it('tolerates _meta:bytes key in dest (half-restored), does not throw non_empty_dest', async () => {
    const { randomUUID } = await import('node:crypto');
    const appId = `kv-restore-test-${randomUUID()}`;

    const euBase = kvBaseOptsFromUrl(euUrl);

    // Only seed the tolerated key
    const eu0 = await RedisClient.connect({ ...euBase, db: 0 });
    await eu0.set(`{${appId}}:_meta:bytes`, '100');
    await eu0.close();

    const kvBaseOptsForRegion = (region: string) => {
      if (region === 'us') return kvBaseOptsFromUrl(usUrl);
      if (region === 'eu') return kvBaseOptsFromUrl(euUrl);
      throw new Error(`unknown region ${region}`);
    };

    // Build a gzip stream with zero records (empty dump)
    const gzStream = buildGzipStream([]);

    const downloadKvDump = vi.fn().mockResolvedValue(gzStream);
    const ctx = makeCtx({ downloadKvDump, kvBaseOptsForRegion });
    const m = makeMigration({
      app_id: appId,
      dest_resources: { kv_dump_object_key: 'move-app/mig-restore-1/dump.kv.jsonl.gz' },
    });

    try {
      const res = await executeRestoreKv(ctx, m);
      expect(res.next).toBe('copying_blobs');
      expect(res.patch).toMatchObject({ kv_restored_at: expect.any(String), kv_restored_records: 0 });
      // Routing flip should have been called
      expect(ctx.controlPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE app_kv_credentials'),
        ['eu', appId],
      );
    } finally {
      const cleanup = await RedisClient.connect({ ...euBase, db: 0 });
      await cleanup.del([`{${appId}}:_meta:bytes`]);
      await cleanup.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Full happy-path integration (needs both Redis URLs + RUN_DB_TESTS)
// ---------------------------------------------------------------------------

const hasFullIntegration = hasRedis && !!process.env.RUN_DB_TESTS;

describe.skipIf(!hasFullIntegration)(
  'executeRestoreKv — full round-trip (dump → restore → routing flip)',
  () => {
    // NOTE: This test seeds KV data in US, runs a real dump, then restores to EU,
    // and verifies the routing flip via a real controlPool query.
    // It is skipped unless KV_REDIS_URL_US, KV_REDIS_URL_EU, and RUN_DB_TESTS are all set.

    it.skip(
      'end-to-end: seed US keys → dump → restore EU → flip routing',
      async () => {
        // TODO (Task 9 smoke): full round-trip with real Postgres controlPool.
        // The happy path is exercised by the smoke test suite in Task 9.
        // Skipped here to avoid requiring a live Postgres in unit CI.
      },
    );
  },
);
