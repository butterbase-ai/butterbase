import { PassThrough, Readable } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { executeRestoreKv, toKvRegion, restoreKvIntoRegion } from './step-restore-kv.js';
import { serializeRecord, type KvDumpRecord } from './kv-dump-format.js';
import { RedisClient } from '../kv/redis-client.js';
import { randomUUID } from 'node:crypto';

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

describe('toKvRegion', () => {
  it('converts long-form saga region (us-east-1) to short form (us)', () => {
    expect(toKvRegion('us-east-1')).toBe('us');
  });

  it('converts long-form saga region (eu-west-1) to short form (eu)', () => {
    expect(toKvRegion('eu-west-1')).toBe('eu');
  });

  it('handles already short-form region (us) without change', () => {
    expect(toKvRegion('us')).toBe('us');
  });

  it('handles already short-form region (eu) without change', () => {
    expect(toKvRegion('eu')).toBe('eu');
  });

  it('converts ap-southeast-1 to ap', () => {
    expect(toKvRegion('ap-southeast-1')).toBe('ap');
  });
});

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

  it('updates app_kv_credentials with short-form region, converting from long-form saga region', async () => {
    const downloadKvDump = vi.fn().mockResolvedValue(buildGzipStream([]));
    const kvBaseOptsForRegion = (region: string) => {
      return { host: 'localhost', port: 6379, password: '' };
    };
    const ctx = makeCtx({ downloadKvDump, kvBaseOptsForRegion });
    const m = makeMigration({
      dest_region: 'eu-west-1',
      dest_resources: { kv_dump_object_key: 'some/key' },
    });

    await executeRestoreKv(ctx, m);

    // Verify controlPool.query was called with short-form 'eu', not 'eu-west-1'
    expect(ctx.controlPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE app_kv_credentials'),
      ['eu', m.app_id],
    );
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

// ---------------------------------------------------------------------------
// restoreKvIntoRegion (exported helper)
// ---------------------------------------------------------------------------

describe('restoreKvIntoRegion (exported helper)', () => {
  it('flips app_kv_credentials.region to toKvRegion(flipTo), not destRegion', async () => {
    if (!process.env.KV_REDIS_URL_US) return; // gated integration

    const url = new URL(process.env.KV_REDIS_URL_US);
    const base = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password ? decodeURIComponent(url.password) : '',
    };

    const controlPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    // Return a properly gzipped empty stream (compressed empty file)
    const downloadKvDump = async () => {
      const pt = new PassThrough();
      const gz = createGzip();
      pt.pipe(gz);
      pt.end(); // empty source → empty gzip
      return gz;
    };

    await restoreKvIntoRegion({
      destRegion: 'us-east-1',
      sourceRegionForBucket: 'eu-west-1',
      appId: `flip-test-${randomUUID()}`,
      key: 'mock-key',
      controlPool,
      flipTo: 'eu-west-1', // distinct from destRegion to prove flipTo is used
      log: { info: vi.fn() },
      downloadFn: downloadKvDump,
      kvBaseOptsForRegion: () => base,
    });

    const updateCall = controlPool.query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('UPDATE app_kv_credentials'),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toBe('eu'); // toKvRegion('eu-west-1') → 'eu'
  });

  it('non-empty dest guard still fires (rejects with non_empty_dest)', async () => {
    if (!process.env.KV_REDIS_URL_US) return; // gated integration

    const url = new URL(process.env.KV_REDIS_URL_US);
    const base = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password ? decodeURIComponent(url.password) : '',
    };
    const appId = `nonempty-test-${randomUUID()}`;

    // Seed a non-_meta:bytes key to trip the guard.
    const c = await RedisClient.connect({ ...base, db: 0 });
    try {
      await c.set(`{${appId}}:u:stale`, 'x');
    } finally {
      await c.close();
    }

    const controlPool = { query: vi.fn() };
    await expect(restoreKvIntoRegion({
      destRegion: 'us-east-1',
      sourceRegionForBucket: 'eu-west-1',
      appId,
      key: 'mock',
      controlPool,
      flipTo: 'us-east-1',
      log: { info: vi.fn() },
      downloadFn: async () => Readable.from([]),
      kvBaseOptsForRegion: () => base,
    })).rejects.toThrow(/non_empty_dest/);

    // Cleanup
    const c2 = await RedisClient.connect({ ...base, db: 0 });
    try { await c2.del([`{${appId}}:u:stale`]); } finally { await c2.close(); }
  });
});
