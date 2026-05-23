import { createGunzip } from 'node:zlib';
import { PassThrough, type Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { executeDumpKv } from './step-dump-kv.js';
import { parseRecord, payloadToBuffer, type KvDumpRecord } from './kv-dump-format.js';
import { RedisClient } from '../kv/redis-client.js';

const makeCtx = (extra: Record<string, any> = {}): any => ({
  controlPool: { query: vi.fn() },
  runtimePoolFor: vi.fn(),
  redisFor: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...extra,
});

const makeMigration = (overrides: Record<string, any> = {}): any => ({
  id: 'mig-kv-1',
  app_id: 'app-kv',
  user_id: 'u',
  source_region: 'us',
  dest_region: 'eu',
  current_step: 'dumping_kv',
  dest_resources: {},
  ...overrides,
});

async function collectGzipedLines(body: Readable): Promise<KvDumpRecord[]> {
  const gunzip = createGunzip();
  body.pipe(gunzip);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', resolve);
    gunzip.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf-8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => parseRecord(l));
}

describe('executeDumpKv', () => {
  it('is idempotent — early-return when kv_dump_object_key already set', async () => {
    const uploadKvDump = vi.fn();
    const ctx = makeCtx({ uploadKvDump });
    const m = makeMigration({ dest_resources: { kv_dump_object_key: 'prior-key' } });

    const res = await executeDumpKv(ctx, m);

    expect(res.next).toBe('restoring_kv');
    expect(res.patch).toEqual({});
    expect(uploadKvDump).not.toHaveBeenCalled();
  });

  it('happy path with injected records — uploads gzipped jsonl, returns correct patch', async () => {
    const fakePayload = Buffer.from('REDISDUMP\x00\x00\x00\x00', 'binary');

    const fakeRecords: KvDumpRecord[] = [
      { db: 0, key: '{app-kv}:u:a', ttl_ms: -1, payload_b64: fakePayload.toString('base64') },
      { db: 0, key: '{app-kv}:u:b', ttl_ms: 30000, payload_b64: fakePayload.toString('base64') },
      { db: 1, key: '{app-kv}:u:c', ttl_ms: -1, payload_b64: fakePayload.toString('base64') },
    ];

    let capturedKey = '';
    let capturedBody: Readable | null = null;

    const uploadKvDump = vi.fn().mockImplementation(async (key: string, body: Readable) => {
      capturedKey = key;
      capturedBody = body;
      // drain the body so the stream pipeline can complete
      await new Promise<void>((resolve, reject) => {
        const sink = new PassThrough();
        body.pipe(sink);
        sink.on('finish', resolve);
        sink.on('error', reject);
      });
      return { key, bytes: 0 };
    });

    const kvDumpRecords = vi.fn().mockReturnValue(
      (async function* () {
        for (const r of fakeRecords) yield r;
      })(),
    );

    const ctx = makeCtx({ uploadKvDump, kvDumpRecords });
    const m = makeMigration();

    // We need to capture body before it's consumed; restructure to collect
    // in parallel with execution.
    let bodyForVerification: Readable | null = null;
    const uploadFn = vi.fn().mockImplementation(async (key: string, body: Readable) => {
      bodyForVerification = body;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        body.on('data', (c: Buffer) => chunks.push(c));
        body.on('end', resolve);
        body.on('error', reject);
      });
      capturedKey = key;
      return { key, bytes: 0 };
    });

    const ctx2 = makeCtx({ uploadKvDump: uploadFn, kvDumpRecords });
    const res = await executeDumpKv(ctx2, m);

    expect(res.next).toBe('restoring_kv');
    expect(res.patch).toMatchObject({
      kv_dump_object_key: 'move-app/mig-kv-1/dump.kv.jsonl.gz',
      kv_dump_records: 3,
    });
    expect(capturedKey).toBe('move-app/mig-kv-1/dump.kv.jsonl.gz');
  });

  it('happy path — gunzipped body contains all 3 records with correct fields', async () => {
    const fakePayload = Buffer.from('REDISDUMP\x00\x00\x00\x00', 'binary');

    const fakeRecords: KvDumpRecord[] = [
      { db: 0, key: '{app-kv}:u:a', ttl_ms: -1, payload_b64: fakePayload.toString('base64') },
      { db: 0, key: '{app-kv}:u:b', ttl_ms: 30000, payload_b64: fakePayload.toString('base64') },
      { db: 1, key: '{app-kv}:u:c', ttl_ms: -1, payload_b64: fakePayload.toString('base64') },
    ];

    const kvDumpRecords = vi.fn().mockReturnValue(
      (async function* () {
        for (const r of fakeRecords) yield r;
      })(),
    );

    let collectedRecords: KvDumpRecord[] = [];

    const uploadFn = vi.fn().mockImplementation(async (key: string, body: Readable) => {
      collectedRecords = await collectGzipedLines(body);
      return { key, bytes: 0 };
    });

    const ctx = makeCtx({ uploadKvDump: uploadFn, kvDumpRecords });
    const m = makeMigration();

    await executeDumpKv(ctx, m);

    expect(collectedRecords).toHaveLength(3);
    const keys = collectedRecords.map((r) => r.key);
    expect(keys).toContain('{app-kv}:u:a');
    expect(keys).toContain('{app-kv}:u:b');
    expect(keys).toContain('{app-kv}:u:c');

    const recB = collectedRecords.find((r) => r.key === '{app-kv}:u:b')!;
    expect(recB.ttl_ms).toBe(30000);
    expect(recB.db).toBe(0);

    // Verify payload round-trips
    for (const rec of collectedRecords) {
      const buf = payloadToBuffer(rec.payload_b64);
      expect(buf.equals(fakePayload)).toBe(true);
    }
  });
});

describe.skipIf(!process.env.KV_REDIS_URL_US)('executeDumpKv — real Redis integration', () => {
  it('scans both DBs, skips rate and sentinel keys, preserves TTL', async () => {
    const { randomUUID } = await import('node:crypto');
    const appId = `kv-dump-test-${randomUUID()}`;

    const { kvBaseOptsForRegion } = await import('./step-dump-kv.js');
    const baseOpts = kvBaseOptsForRegion('us');

    // Seed keys in DB 0
    const db0 = await RedisClient.connect({ ...baseOpts, db: 0 });
    await db0.set(`{${appId}}:u:a`, 'val-a');
    await db0.setex(`{${appId}}:u:b`, 60, 'val-b');
    await db0.set(`{${appId}}:_meta:bytes`, '20');
    await db0.setex(`{${appId}}:_meta:rate:9999`, 1, '50'); // should be SKIPPED
    await db0.set(`{${appId}}:_meta:migration`, '1'); // should be SKIPPED
    await db0.close();

    // Seed keys in DB 1
    const db1 = await RedisClient.connect({ ...baseOpts, db: 1 });
    await db1.set(`{${appId}}:u:ephem`, 'val-ephem');
    await db1.close();

    let collectedRecords: KvDumpRecord[] = [];

    const uploadFn = vi.fn().mockImplementation(async (key: string, body: Readable) => {
      collectedRecords = await collectGzipedLines(body);
      return { key, bytes: 0 };
    });

    const ctx = makeCtx({
      uploadKvDump: uploadFn,
      kvBaseOptsForRegion: () => baseOpts,
    });
    const m = makeMigration({ app_id: appId, source_region: 'us' });

    await executeDumpKv(ctx, m);

    const keys = collectedRecords.map((r) => r.key);
    expect(keys).toContain(`{${appId}}:u:a`);
    expect(keys).toContain(`{${appId}}:u:b`);
    expect(keys).toContain(`{${appId}}:_meta:bytes`);
    expect(keys).toContain(`{${appId}}:u:ephem`);

    // Rate and migration sentinel must be skipped
    expect(keys).not.toContain(`{${appId}}:_meta:rate:9999`);
    expect(keys).not.toContain(`{${appId}}:_meta:migration`);

    // TTL should be preserved for :u:b (EX 60 → ~60000ms)
    const recB = collectedRecords.find((r) => r.key === `{${appId}}:u:b`);
    expect(recB).toBeDefined();
    expect(recB!.ttl_ms).toBeGreaterThan(0);
    expect(recB!.ttl_ms).toBeLessThanOrEqual(60000);

    // DB-1 key should have db=1
    const recEphem = collectedRecords.find((r) => r.key === `{${appId}}:u:ephem`);
    expect(recEphem).toBeDefined();
    expect(recEphem!.db).toBe(1);

    // Cleanup
    const cleanup0 = await RedisClient.connect({ ...baseOpts, db: 0 });
    await cleanup0.del([
      `{${appId}}:u:a`,
      `{${appId}}:u:b`,
      `{${appId}}:_meta:bytes`,
      `{${appId}}:_meta:rate:9999`,
      `{${appId}}:_meta:migration`,
    ]);
    await cleanup0.close();

    const cleanup1 = await RedisClient.connect({ ...baseOpts, db: 1 });
    await cleanup1.del([`{${appId}}:u:ephem`]);
    await cleanup1.close();
  });
});
