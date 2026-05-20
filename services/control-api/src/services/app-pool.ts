import pg from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { getLimitsForApp } from './app-plan-resolver.js';

interface PoolEntry {
  pool: pg.Pool;
  lastUsed: number;
}

const MAX_POOLS = parseInt(process.env.APP_POOL_MAX_POOLS ?? '100', 10);
const POOL_SIZE = parseInt(process.env.APP_POOL_SIZE ?? '5', 10);
const FALLBACK_STATEMENT_TIMEOUT_MS = 60000;

const pools = new Map<string, PoolEntry>();
const timeoutConfigured = new WeakSet<pg.Pool>();

function attachStatementTimeout(pool: pg.Pool, timeoutMs: number): void {
  if (timeoutConfigured.has(pool)) return;
  timeoutConfigured.add(pool);
  const effective = timeoutMs > 0 ? timeoutMs : FALLBACK_STATEMENT_TIMEOUT_MS;
  pool.on('connect', (client) => {
    client
      .query(`SET statement_timeout TO ${effective}`)
      .catch(() => {
        // Non-fatal: a missing timeout is safer than crashing the pool.
      });
  });
}

function evictOldestIfNeeded(): void {
  if (pools.size >= MAX_POOLS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, e] of pools) {
      if (e.lastUsed < oldestTime) {
        oldestTime = e.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = pools.get(oldestKey)!;
      pools.delete(oldestKey);
      evicted.pool.end().catch(() => {});
    }
  }
}

/**
 * Pool for app data-plane queries. If the app was provisioned on Neon, `app_db_connections`
 * has a row and we use that URI; otherwise PgBouncer/direct to local data plane `dbName`.
 * (Avoids coupling to `NEON_API_KEY` alone — tests and local DBs without rows keep working.)
 */
export async function getAppPoolForApp(
  controlDb: pg.Pool,
  appId: string,
  dbName: string
): Promise<pg.Pool> {
  const cached = pools.get(appId) ?? (dbName !== appId ? pools.get(dbName) : undefined);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.pool;
  }

  // Find the app's home region from the cross-region user_app_index. The
  // per-region runtime DB only stores app_db_connections rows for apps
  // homed in that region — a local-region lookup misses cross-region apps
  // and falls back to PgBouncer/localhost (ECONNREFUSED in production).
  const idx = await controlDb.query<{ region: string }>(
    'SELECT region FROM user_app_index WHERE app_id = $1',
    [appId]
  );
  const region = idx.rows[0]?.region;
  if (!region) {
    throw new Error(`app ${appId} not in user_app_index`);
  }
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const result = await runtimeDb.query<{ connection_string: string }>(
    'SELECT connection_string FROM app_db_connections WHERE app_id = $1',
    [appId]
  );

  const pool = result.rows.length > 0
    ? getAppPoolByConnectionString(appId, result.rows[0].connection_string)
    : getAppPool(dbName);

  if (!timeoutConfigured.has(pool)) {
    const limits = await getLimitsForApp(controlDb, appId).catch(() => null);
    attachStatementTimeout(pool, limits?.statementTimeoutMs ?? FALLBACK_STATEMENT_TIMEOUT_MS);
  }

  return pool;
}

export function getAppPool(dbName: string): pg.Pool {
  const entry = pools.get(dbName);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.pool;
  }

  evictOldestIfNeeded();

  // Use PgBouncer when available (Docker), fall back to direct Data Plane connection
  const isLocal = config.nodeEnv !== 'production' && config.pgbouncer.host === 'localhost';
  const useDirectConnection = isLocal;
  const pool = new pg.Pool({
    host: useDirectConnection ? config.dataPlaneDb.host : config.pgbouncer.host,
    port: useDirectConnection ? config.dataPlaneDb.port : config.pgbouncer.port,
    user: config.dataPlaneDb.user,
    password: config.dataPlaneDb.password,
    database: dbName,
    max: POOL_SIZE,
  });

  pools.set(dbName, { pool, lastUsed: Date.now() });
  return pool;
}

/**
 * Get a pool using a full connection string (for Neon production mode).
 * Keyed by appId to allow LRU eviction.
 */
export function getAppPoolByConnectionString(appId: string, connectionString: string): pg.Pool {
  const entry = pools.get(appId);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.pool;
  }

  evictOldestIfNeeded();

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'pgbouncer', 'data-plane-db']);
  let host: string | undefined;
  try { host = new URL(connectionString).hostname; } catch { /* ignore */ }
  const useSSL = host ? !LOCAL_HOSTS.has(host) : true;

  const pool = new pg.Pool({
    connectionString,
    max: POOL_SIZE,
    ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  pools.set(appId, { pool, lastUsed: Date.now() });
  return pool;
}

export async function closeAllPools(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [, entry] of pools) {
    promises.push(entry.pool.end());
  }
  pools.clear();
  await Promise.all(promises);
}
