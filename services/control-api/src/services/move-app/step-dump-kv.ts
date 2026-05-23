import { PassThrough, type Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { StepHandler } from './saga-executor.js';
import { RedisClient, type RedisClientOptions } from '../kv/redis-client.js';
import { serializeRecord, payloadFromBuffer, type KvDumpRecord } from './kv-dump-format.js';

export interface DumpKvCtx {
  uploadKvDump?: (key: string, body: Readable) => Promise<{ key: string; bytes: number }>;
  /** Test hook — yields records directly, skipping Redis. */
  kvDumpRecords?: (region: string, appId: string) => AsyncIterable<KvDumpRecord>;
  /** Test hook — provides KV connection opts so the default iterator can scan a real test Redis. */
  kvBaseOptsForRegion?: (region: string) => Omit<RedisClientOptions, 'db'>;
}

function bucketForRegion(region: string): string {
  const envKey = `MOVE_APP_DUMP_BUCKET_${region.toUpperCase().replace(/-/g, '_')}`;
  const val = process.env[envKey] ?? process.env.MOVE_APP_DUMP_BUCKET;
  if (!val) throw new Error(`Missing ${envKey} (or MOVE_APP_DUMP_BUCKET fallback) for region ${region}`);
  return val;
}

function defaultS3Client(region: string): S3Client {
  const cfg: S3ClientConfig = {
    region: process.env.MOVE_APP_DUMP_BUCKET_REGION ?? region,
  };
  if (process.env.R2_ENDPOINT) {
    cfg.endpoint = process.env.R2_ENDPOINT;
    cfg.forcePathStyle = true;
  }
  return new S3Client(cfg);
}

async function defaultUpload(region: string, key: string, body: Readable) {
  const client = defaultS3Client(region);
  const uploader = new Upload({
    client,
    params: { Bucket: bucketForRegion(region), Key: key, Body: body },
  });
  await uploader.done();
  return { key, bytes: 0 };
}

export function kvBaseOptsForRegion(region: string): Omit<RedisClientOptions, 'db'> {
  const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
  const url = process.env[envKey];
  if (!url) throw new Error(`Missing ${envKey}`);
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

function shouldSkipKey(appId: string, key: string): boolean {
  const prefix = `{${appId}}:_meta:`;
  if (!key.startsWith(prefix)) return false;
  // Skip transient rate buckets and the migration sentinel; keep bytes/expose/etc.
  const suffix = key.slice(prefix.length);
  return suffix.startsWith('rate:') || suffix === 'migration';
}

async function* defaultIterateRecords(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
): AsyncGenerator<KvDumpRecord> {
  for (const db of [0, 1] as const) {
    const c = await RedisClient.connect({ ...baseOpts, db });
    try {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, `{${appId}}:*`, 500);
        cursor = next;
        for (const k of keys) {
          if (shouldSkipKey(appId, k)) continue;
          const payload = await c.dump(k);
          if (!payload) continue; // key vanished mid-scan
          const pttl = await c.pttl(k);
          if (pttl === -2) continue; // expired mid-scan
          const ttl_ms = pttl === -1 ? -1 : pttl;
          yield { db, key: k, ttl_ms, payload_b64: payloadFromBuffer(payload) };
        }
      } while (cursor !== '0');
    } finally {
      await c.close();
    }
  }
}

export const executeDumpKv: StepHandler = async (ctx, m) => {
  if (m.dest_resources.kv_dump_object_key) {
    return { next: 'restoring_kv', patch: {} };
  }
  const cx = ctx as unknown as DumpKvCtx & typeof ctx;
  const uploadFn = cx.uploadKvDump
    ? cx.uploadKvDump
    : (k: string, body: Readable) => defaultUpload(m.source_region, k, body);
  const iter = cx.kvDumpRecords
    ? cx.kvDumpRecords(m.source_region, m.app_id)
    : defaultIterateRecords(
        (cx.kvBaseOptsForRegion ?? kvBaseOptsForRegion)(m.source_region),
        m.app_id,
      );

  const key = `move-app/${m.id}/dump.kv.jsonl.gz`;
  const lines = new PassThrough();
  const gz = createGzip();
  lines.pipe(gz);
  const uploadPromise = uploadFn(key, gz);

  let recordCount = 0;
  try {
    for await (const rec of iter) {
      lines.write(serializeRecord(rec) + '\n');
      recordCount++;
    }
    lines.end();
  } catch (e) {
    lines.destroy(e as Error);
    throw e;
  }

  const upResult = await uploadPromise;
  ctx.log.info(
    { migrationId: m.id, key: upResult.key, records: recordCount },
    'kv dump uploaded',
  );
  return {
    next: 'restoring_kv',
    patch: { kv_dump_object_key: upResult.key, kv_dump_records: recordCount },
  };
};
