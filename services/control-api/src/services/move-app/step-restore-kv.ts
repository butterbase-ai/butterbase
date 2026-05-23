import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { StepHandler } from './saga-executor.js';
import { RedisClient, type RedisClientOptions } from '../kv/redis-client.js';
import { parseRecord, payloadToBuffer } from './kv-dump-format.js';

/**
 * Convert long-form saga regions (`us-east-1`, `eu-west-1`) to the short
 * form (`us`, `eu`) that `app_kv_credentials.region` stores by convention.
 * The KV preHandler builds its env-var lookup from this column, so the
 * short form must match `KV_REDIS_URL_<REGION>` env var naming.
 */
export function toKvRegion(region: string): string {
  return region.replace(/-[a-z]+-\d+$/, '');
}

export interface RestoreKvCtx {
  downloadKvDump?: (key: string) => Promise<Readable>;
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

async function defaultDownload(sourceRegion: string, key: string): Promise<Readable> {
  const client = defaultS3Client(sourceRegion);
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucketForRegion(sourceRegion), Key: key }),
  );
  if (!resp.Body) throw new Error(`kv dump body missing for ${key}`);
  return resp.Body as Readable;
}

function defaultBaseOpts(region: string): Omit<RedisClientOptions, 'db'> {
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

async function assertDestEmpty(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
): Promise<void> {
  for (const db of [0, 1] as const) {
    const c = await RedisClient.connect({ ...baseOpts, db });
    try {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, `{${appId}}:*`, 100);
        cursor = next;
        const bad = keys.filter((k) => !k.endsWith(':_meta:bytes'));
        if (bad.length > 0) {
          throw new Error(`non_empty_dest: ${bad.length} keys present (sample: ${bad[0]})`);
        }
      } while (cursor !== '0');
    } finally {
      await c.close();
    }
  }
}

export const executeRestoreKv: StepHandler = async (ctx, m) => {
  if (m.dest_resources.kv_restored_at) {
    return { next: 'copying_blobs', patch: {} };
  }

  const cx = ctx as unknown as RestoreKvCtx & typeof ctx;

  const key = m.dest_resources.kv_dump_object_key as string | undefined;
  if (!key) {
    throw new Error(`restore_kv: missing kv_dump_object_key on migration ${m.id}`);
  }

  const baseOptsFn = cx.kvBaseOptsForRegion ?? defaultBaseOpts;
  const destBase = baseOptsFn(m.dest_region);

  await assertDestEmpty(destBase, m.app_id);

  const body = cx.downloadKvDump
    ? await cx.downloadKvDump(key)
    : await defaultDownload(m.source_region, key);

  const gunzipped = body.pipe(createGunzip());
  const rl = createInterface({ input: gunzipped, crlfDelay: Infinity });

  // Cache one RedisClient per DB; reuse for all records of that DB.
  const clients = new Map<0 | 1, RedisClient>();
  async function clientForDb(db: 0 | 1): Promise<RedisClient> {
    let c = clients.get(db);
    if (!c) {
      c = await RedisClient.connect({ ...destBase, db });
      clients.set(db, c);
    }
    return c;
  }

  let restored = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const rec = parseRecord(line);
      const c = await clientForDb(rec.db);
      const ttl = rec.ttl_ms < 0 ? 0 : rec.ttl_ms;
      await c.restore(rec.key, ttl, payloadToBuffer(rec.payload_b64), { replace: true });
      restored++;
    }
  } finally {
    for (const c of clients.values()) await c.close();
  }

  await ctx.controlPool.query(
    'UPDATE app_kv_credentials SET region = $1, rotated_at = now() WHERE app_id = $2',
    [toKvRegion(m.dest_region), m.app_id],
  );

  ctx.log.info({ migrationId: m.id, restored }, 'kv restored + routing flipped');
  return {
    next: 'copying_blobs',
    patch: {
      kv_restored_at: new Date().toISOString(),
      kv_restored_records: restored,
    },
  };
};
