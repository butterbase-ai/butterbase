import pg from 'pg';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { AppNotFoundError } from './app-resolver.js';
import { getRedisClient } from './redis.js';

const TTL_SECONDS = 300;
const cacheKey = (appId: string) => `app-region:${appId}`;

type RedisLike = Pick<Redis, 'get' | 'setex' | 'del'>;

/**
 * Resolves the app's home region. Queries the cross-region `user_app_index`
 * on the platform/control DB so the lookup works from any region.
 *
 * The per-region `apps` table only contains rows for apps homed in that
 * region — a us-east-1 machine querying its local runtime DB for a
 * us-west-2 app finds nothing and would 404 the request instead of
 * fly-replaying it. `user_app_index` is the authoritative cross-region
 * map (written by addUserAppIndex on init, updated by move-app).
 */
export async function resolveAppRegion(
  controlPool: pg.Pool,
  redis: RedisLike,
  appId: string,
): Promise<string | null> {
  const cached = await redis.get(cacheKey(appId));
  if (cached) return cached;

  const r = await controlPool.query<{ region: string }>(
    `SELECT region FROM user_app_index WHERE app_id = $1`,
    [appId],
  );
  if (r.rows.length === 0) return null;

  const region = r.rows[0].region;
  await redis.setex(cacheKey(appId), TTL_SECONDS, region);
  return region;
}

export async function invalidateAppRegion(redis: RedisLike, appId: string): Promise<void> {
  await redis.del(cacheKey(appId));
}

/** Returns this Fly machine's configured region. Falls back to 'local' if unset. */
export function resolveLocalRegion(): string {
  return process.env.BUTTERBASE_REGION ?? 'local';
}

/**
 * Strict variant of resolveAppRegion: returns the home region or throws
 * AppNotFoundError. Use this from route handlers that already need a pool
 * to per-app runtime tables — the lookup will eventually fail the request
 * with a 404 anyway. Cached via Redis (same key as resolveAppRegion).
 */
export async function resolveAppHomeRegion(
  controlPool: pg.Pool,
  appId: string,
): Promise<string> {
  const region = await resolveAppRegion(controlPool, getRedisClient(), appId);
  if (!region) throw new AppNotFoundError(appId);
  return region;
}

/**
 * Returns the pg.Pool for the runtime DB that hosts this app. Combines
 * resolveAppHomeRegion + getRuntimeDbPool — the canonical entry point
 * for any route handler / service that needs to read or write a per-app
 * row keyed by app_id.
 *
 * Throws AppNotFoundError when the app isn't in user_app_index.
 *
 * Use this instead of `app.runtimeDb(assertRegionConfig().instanceRegion)`
 * for any per-app query. Code that operates on neon_tasks /
 * rag_ingestion_queue (per-region queues, not per-app) keeps using
 * instanceRegion.
 */
export async function getRuntimeDbForApp(
  controlPool: pg.Pool,
  appId: string,
): Promise<pg.Pool> {
  const region = await resolveAppHomeRegion(controlPool, appId);
  return getRuntimeDbPool(config.runtimeDb, region);
}

/** Returns the list of region slugs that have a configured runtime DB. */
export function getConfiguredRuntimeRegions(): string[] {
  return Object.keys(config.runtimeDb.urlsByRegion);
}

/**
 * Run *fn* against every configured region's runtime pool in parallel.
 * Returns a list of {region, result} pairs. A failure in one region is
 * surfaced as a thrown error from Promise.all (caller handles).
 *
 * Use this for admin/operator queries that aggregate across regions
 * (counts, lists, etc.). For per-app queries use getRuntimeDbForApp.
 */
export async function fanOutRuntimeRegions<T>(
  fn: (pool: pg.Pool, region: string) => Promise<T>,
): Promise<Array<{ region: string; result: T }>> {
  const regions = getConfiguredRuntimeRegions();
  const out = await Promise.all(
    regions.map(async (region) => ({
      region,
      result: await fn(getRuntimeDbPool(config.runtimeDb, region), region),
    })),
  );
  return out;
}

/**
 * Convenience: run the same SQL on every region and return the concatenated
 * rows. The caller is responsible for ordering / pagination / dedup of the
 * merged set.
 */
export async function fanOutQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const parts = await fanOutRuntimeRegions(async (pool) => {
    const r = await pool.query<R>(sql, params);
    return r.rows;
  });
  return parts.flatMap((p) => p.result);
}
