// services/control-api/src/services/usage-metering.ts
import { Pool, PoolClient } from 'pg';
import { getRedisClient } from './redis.js';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { resolveOrganizationId } from './org-resolver.js';
import { fireCreditsEmailForOrg } from './credits-email.js';

type DbClient = Pool | PoolClient;

// Meter types
export type MeterType =
  | 'api_calls'
  | 'storage_bytes'
  | 'ai_tokens'
  | 'lambda_invocations'
  | 'bandwidth_bytes'
  | 'mau'
  | 'do_requests'
  | 'do_cpu_ms'
  | 'do_storage_gb_seconds'
  | 'kv_ops'
  | 'kv_storage_bytes'
  | 'people_credits';


export class UsageMeteringError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'UsageMeteringError';
  }
}

/**
 * Increment usage counter (hot path - Redis only, non-blocking)
 */
export async function incrementUsage(
  organizationId: string,
  userId: string,
  meterType: MeterType,
  quantity: number = 1,
  appId?: string
): Promise<void> {
  try {
    const periodStart = getCurrentPeriodStart();
    const key = getRedisKey(organizationId, userId, meterType, periodStart, appId);

    // Fire-and-forget increment
    getRedisClient().incrby(key, quantity).catch((err: Error) => {
      console.error(`Failed to increment usage for ${key}:`, err);
    });

    // Set expiry to 35 days (to cover monthly period + buffer)
    getRedisClient().expire(key, 35 * 24 * 60 * 60).catch((err: Error) => {
      console.error(`Failed to set expiry for ${key}:`, err);
    });
  } catch (error) {
    // Don't throw - usage metering should never block requests
    console.error('Usage metering error:', error);
  }
}

/**
 * Get current usage for a meter (reads from Redis + DB)
 */
export async function getCurrentUsage(
  db: DbClient,
  organizationId: string,
  meterType: MeterType,
  appId?: string,
  userId?: string
): Promise<number> {
  try {
    const periodStart = getCurrentPeriodStart();

    // Redis holds per-user counters (see d688aa1 — usage_meters.user_id NOT
    // NULL means every counter must be user-attributed). When a caller
    // requests an org-wide total (no userId), skip Redis and read the
    // aggregated DB row (flushed from Redis every minute). The Redis-only
    // freshness window is intentionally sacrificed for org-wide reads to
    // avoid a SCAN across the userId dimension.
    let redisUsage = 0;
    if (userId) {
      const redisKey = getRedisKey(organizationId, userId, meterType, periodStart, appId);
      const redisValue = await getRedisClient().get(redisKey);
      redisUsage = redisValue ? parseInt(redisValue, 10) : 0;
    }

    // usage_meters is per-region. When appId is given, hit the app's home
    // region. When not (org-scoped counter — app_id IS NULL), sum across
    // every region since the row could live in any of them.
    let dbUsage = 0;
    if (appId) {
      const runtimePool = await getRuntimeDbForApp(db as Pool, appId);
      const result = await runtimePool.query(
        'SELECT quantity FROM usage_meters WHERE organization_id = $1 AND meter_type = $2 AND period_start = $3 AND app_id = $4',
        [organizationId, meterType, periodStart, appId]
      );
      dbUsage = result.rows.length > 0 ? parseInt(result.rows[0].quantity, 10) : 0;
    } else {
      for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
        const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
        const result = await runtimePool.query(
          'SELECT quantity FROM usage_meters WHERE organization_id = $1 AND meter_type = $2 AND period_start = $3 AND app_id IS NULL',
          [organizationId, meterType, periodStart]
        );
        if (result.rows.length > 0) dbUsage += parseInt(result.rows[0].quantity, 10);
      }
    }

    return redisUsage + dbUsage;
  } catch (error) {
    throw new UsageMeteringError(
      `Failed to get current usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'GET_USAGE_FAILED'
    );
  }
}

/**
 * Flush Redis counters to database (warm path - background job)
 * Should be called every 60 seconds by a background worker
 */
export async function flushUsageToDatabase(db: Pool): Promise<void> {
  try {
    const pattern = 'usage_org:*';
    const keys = await getRedisClient().keys(pattern);

    if (keys.length === 0) {
      return;
    }

    // usage_meters is per-region. For app-scoped counters, pick the app's
    // home runtime DB. For org-scoped (no app_id), default to us-east-1 —
    // org-scoped meters need consistent placement; getCurrentUsage fans
    // out reads, so the placement region just needs to be stable.
    const eastPool = getRuntimeDbPool(config.runtimeDb, 'us-east-1');

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);

      for (const key of batch) {
        // Atomic get-and-delete to prevent race conditions with concurrent increments
        const value = await getRedisClient().getdel(key);
        if (!value || value === '0') continue;

        const quantity = parseInt(value, 10);
        const parsed = parseRedisKey(key);

        if (!parsed) continue;

        const runtimePool = parsed.appId
          ? await getRuntimeDbForApp(db, parsed.appId).catch(() => null)
          : eastPool;
        if (!runtimePool) continue; // app no longer in org_app_index — drop

        const query = `
          INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, app_id, meter_type, period_start)
          DO UPDATE SET quantity = usage_meters.quantity + EXCLUDED.quantity, updated_at = now()
        `;

        try {
          await runtimePool.query(query, [
            parsed.userId,
            parsed.organizationId,
            parsed.appId || null,
            parsed.meterType,
            parsed.periodStart,
            quantity,
          ]);
        } catch (err: any) {
          // FK violation (23503) means the app was deleted between usage
          // recording and this flush — discard the orphaned counter silently.
          if (err?.code === '23503') {
            console.log(`Discarding orphaned usage for deleted app ${parsed.appId} (meter: ${parsed.meterType}, qty: ${quantity})`);
          } else {
            throw err;
          }
        }
      }
    }

    console.log(`Flushed ${keys.length} usage counters to database`);
  } catch (error) {
    // Org-resolution failures indicate missing/corrupt user data and must
    // bubble out — never silently swallow them.
    if (error instanceof Error && /resolveOrganizationId:/.test(error.message)) {
      throw error;
    }
    console.error('Failed to flush usage to database:', error);
    // Don't throw - let the next flush attempt handle it
  }
}

/**
 * Purge all buffered Redis usage keys for a specific app.
 * Must be called BEFORE deleting the app row from the database,
 * so the background flush worker never tries to INSERT a row
 * referencing a deleted app_id (which would violate the FK constraint).
 */
export async function purgeAppUsage(appId: string): Promise<number> {
  try {
    const pattern = `usage_org:*:*:*:${appId}`;
    const keys = await getRedisClient().keys(pattern);
    if (keys.length > 0) {
      await getRedisClient().del(...keys);
    }
    return keys.length;
  } catch (error) {
    // Best-effort — the FK catch in flushUsageToDatabase handles any stragglers
    console.warn(`Failed to purge usage keys for app ${appId}:`, error);
    return 0;
  }
}

/**
 * Reconcile usage from source tables (cold path - daily cron)
 */
export async function reconcileUsage(db: Pool, userId: string, periodStart: string): Promise<void> {
  // A user may have apps in multiple regions. Reconcile each region's
  // runtime DB in its own pool — writes stay local-to-app (apps row lives
  // in the same region as its source tables) so this preserves placement.
  const organizationId = await resolveOrganizationId(db, userId);
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    await reconcileUsageInRegion(getRuntimeDbPool(config.runtimeDb, region), userId, periodStart, organizationId);
  }
}

async function reconcileUsageInRegion(runtimePool: Pool, userId: string, periodStart: string, organizationId: string): Promise<void> {
  try {
    // All source tables (storage_objects, ai_usage_logs, function_invocations, app_users,
    // apps, app_db_connections, usage_meters) are runtime-tier — use runtimePool

    // Reconcile storage usage
    const storageResult = await runtimePool.query(
      `SELECT app_id, COALESCE(SUM(size_bytes), 0) as total
       FROM storage_objects
       WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)
       GROUP BY app_id`,
      [organizationId]
    );

    for (const row of storageResult.rows) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, 'storage_bytes', $4, $5)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [userId, organizationId, row.app_id, periodStart, row.total]
      );
    }

    // Reconcile AI tokens — key on user_id (post-028), since app_id is
    // nullable and the caller can also hit AI on apps they don't own.
    // Both cases were silently dropped under the old apps.owner_id join.
    const aiResult = await runtimePool.query(
      `SELECT app_id, COALESCE(SUM(total_tokens), 0) as total
       FROM ai_usage_logs
       WHERE user_id = $1
         AND DATE(created_at) >= $2
       GROUP BY app_id`,
      [userId, periodStart]
    );

    for (const row of aiResult.rows) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, 'ai_tokens', $4, $5)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [userId, organizationId, row.app_id, periodStart, row.total]
      );
    }

    // Reconcile lambda invocations
    const lambdaResult = await runtimePool.query(
      `SELECT app_id, COUNT(*) as total
       FROM function_invocations
       WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)
         AND DATE(started_at) >= $2
       GROUP BY app_id`,
      [organizationId, periodStart]
    );

    for (const row of lambdaResult.rows) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, 'lambda_invocations', $4, $5)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [userId, organizationId, row.app_id, periodStart, row.total]
      );
    }

    // Reconcile MAU from app_users last_sign_in
    const mauResult = await runtimePool.query(
      `SELECT a.id as app_id, COUNT(DISTINCT au.id) as total
       FROM app_users au
       JOIN apps a ON au.app_id = a.id
       WHERE a.organization_id = $1
         AND au.last_sign_in_at >= $2
       GROUP BY a.id`,
      [organizationId, periodStart]
    );

    for (const row of mauResult.rows) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, 'mau', $4, $5)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [userId, organizationId, row.app_id, periodStart, row.total]
      );
    }

    // Reconcile db_size from actual database sizes (apps + app_db_connections are runtime-tier)
    const dbAppsResult = await runtimePool.query(
      `SELECT a.id, a.db_name, adc.connection_string
       FROM apps a
       LEFT JOIN app_db_connections adc ON adc.app_id = a.id
       WHERE a.organization_id = $1 AND a.db_provisioned = true`,
      [organizationId]
    );

    for (const appRow of dbAppsResult.rows) {
      if (!appRow.connection_string) continue;

      let tempPool: Pool | null = null;
      try {
        tempPool = new Pool({
          connectionString: appRow.connection_string,
          max: 1,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 1000,
        });
        const sizeResult = await tempPool.query(
          'SELECT pg_database_size(current_database()) as size'
        );
        const dbSizeBytes = parseInt(sizeResult.rows[0].size, 10);

        await runtimePool.query(
          `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
           VALUES ($1, $2, $3, 'db_size_bytes', $4, $5)
           ON CONFLICT (user_id, app_id, meter_type, period_start)
           DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
          [userId, organizationId, appRow.id, periodStart, dbSizeBytes]
        );
      } catch (err) {
        console.error(`Failed to measure db_size for app ${appRow.id}:`, err);
      } finally {
        if (tempPool) {
          await tempPool.end().catch(() => {});
        }
      }
    }

    console.log(`Reconciled usage for user ${userId} for period ${periodStart}`);
  } catch (error) {
    throw new UsageMeteringError(
      `Failed to reconcile usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RECONCILE_FAILED'
    );
  }
}

// Helper functions

function getCurrentPeriodStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function getRedisKey(organizationId: string, userId: string, meterType: MeterType, periodStart: string, appId?: string): string {
  return appId
    ? `usage_org:${organizationId}:${userId}:${meterType}:${periodStart}:${appId}`
    : `usage_org:${organizationId}:${userId}:${meterType}:${periodStart}`;
}

function parseRedisKey(key: string): {
  organizationId: string;
  userId: string;
  appId?: string;
  meterType: MeterType;
  periodStart: string;
} | null {
  const parts = key.split(':');
  if (parts[0] !== 'usage_org') return null;

  if (parts.length === 6) {
    // With appId: usage_org:orgId:userId:meterType:periodStart:appId
    return {
      organizationId: parts[1],
      userId: parts[2],
      meterType: parts[3] as MeterType,
      periodStart: parts[4],
      appId: parts[5],
    };
  } else if (parts.length === 5) {
    // Without appId: usage_org:orgId:userId:meterType:periodStart
    return {
      organizationId: parts[1],
      userId: parts[2],
      meterType: parts[3] as MeterType,
      periodStart: parts[4],
    };
  }

  return null;
}

/**
 * Start background flush worker (call this on server startup)
 */
export function startFlushWorker(db: Pool, intervalMs: number = 60000): NodeJS.Timeout {
  const interval = setInterval(async () => {
    try {
      const redis = getRedisClient();
      const lockTtl = Math.max(Math.floor(intervalMs / 1000) - 5, 10);
      const acquired = await redis.set('lock:usage-flush', '1', 'EX', lockTtl, 'NX');
      if (acquired !== 'OK') return;
      await flushUsageToDatabase(db);
    } catch (err) {
      console.error('Flush worker error:', err);
    }
  }, intervalMs);

  console.log(`Usage metering flush worker started (interval: ${intervalMs}ms)`);
  return interval;
}

/**
 * Get total AI credits (USD) used by an organization for the current billing period.
 * All tiers now use monthly billing periods (V1 pricing).
 * Queries ai_usage_logs directly (source of truth) and caches for 30 seconds.
 * Only counts platform key usage (not BYOK).
 */
export async function getAiCreditsUsed(db: DbClient, organizationId: string, lifetime: boolean = false): Promise<number> {
  const periodStart = getCurrentPeriodStart();
  const cacheKey = lifetime
    ? `ai_credits_org_lifetime:${organizationId}`
    : `ai_credits_org:${organizationId}:${periodStart}`;

  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached !== null) return parseFloat(cached);
  } catch {
    // Redis failure — fall through to DB query
  }

  // ai_usage_logs and apps are per-region — sum across every configured region.
  let total = 0;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const result = lifetime
      ? await runtimePool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total
           FROM ai_usage_logs
           WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)
             AND key_type = 'platform'`,
          [organizationId]
        )
      : await runtimePool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total
           FROM ai_usage_logs
           WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)
             AND key_type = 'platform'
             AND DATE(created_at) >= $2`,
          [organizationId, periodStart]
        );
    total += parseFloat(result.rows[0].total);
  }

  getRedisClient().setex(cacheKey, 30, total.toString()).catch(() => {});
  return total;
}

/**
 * Get total storage bytes used across all apps in an organization.
 * Queries storage_objects directly (source of truth) and caches for 30 seconds.
 */
export async function getStorageUsed(db: DbClient, organizationId: string): Promise<number> {
  const cacheKey = `storage_used_org:${organizationId}`;

  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached !== null) return parseFloat(cached);
  } catch {
    // Redis failure — fall through to DB query
  }

  // storage_objects and apps are per-region — sum across every region.
  let total = 0;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimePool.query(
      `SELECT COALESCE(SUM(size_bytes), 0) as total
       FROM storage_objects
       WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)`,
      [organizationId]
    );
    total += parseFloat(result.rows[0].total);
  }

  getRedisClient().setex(cacheKey, 30, total.toString()).catch(() => {});
  return total;
}

/**
 * Get monthly active users (MAU) across all apps in an organization.
 * Counts distinct app_users who signed in during the current billing period.
 * Queries app_users directly (source of truth) and caches for 60 seconds.
 */
export async function getMAU(db: DbClient, organizationId: string): Promise<number> {
  const periodStart = getCurrentPeriodStart();
  const cacheKey = `mau_org:${organizationId}:${periodStart}`;

  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached !== null) return parseFloat(cached);
  } catch {
    // Redis failure — fall through to DB query
  }

  // app_users and apps are per-region — sum the per-region counts.
  let total = 0;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimePool.query(
      `SELECT COUNT(DISTINCT au.id) as total
       FROM app_users au
       WHERE au.app_id IN (SELECT id FROM apps WHERE organization_id = $1)
         AND au.last_sign_in_at >= $2`,
      [organizationId, periodStart]
    );
    total += parseInt(result.rows[0].total, 10);
  }

  getRedisClient().setex(cacheKey, 60, total.toString()).catch(() => {});
  return total;
}

/** Per-app database connections opened at once when sizing an org's apps. */
export const DB_SIZE_CONCURRENCY = 6;
const DB_SIZE_FRESH_TTL_S = 300;
const DB_SIZE_LAST_KNOWN_TTL_S = 7 * 24 * 60 * 60;
const DB_SIZE_REFRESH_LOCK_TTL_S = 120;

/**
 * Total database size (bytes) across an organization's provisioned app
 * databases.
 *
 * Measuring it opens a connection to every app's database (pg_database_size,
 * the source of truth), which for a 25-app org took ~14s when done one app at
 * a time — the bulk of a 16.7s /dashboard/billing response. So:
 *   - apps are sized DB_SIZE_CONCURRENCY at a time;
 *   - a fresh value (≤5 min) is served from Redis as before;
 *   - past that, the last known value is returned immediately and a single
 *     refresh runs in the background (a lock keeps concurrent readers from
 *     each starting one). Only an org with no known size waits on a measure.
 * Database size moves slowly; a reading one refresh old is fine for both the
 * billing page and quota checks.
 */
export async function getDbSize(db: DbClient, organizationId: string): Promise<number> {
  const freshKey = `db_size_org:${organizationId}`;
  const lastKnownKey = `db_size_org_last:${organizationId}`;

  try {
    const [fresh, lastKnown] = await Promise.all([
      getRedisClient().get(freshKey),
      getRedisClient().get(lastKnownKey),
    ]);
    if (fresh !== null) return parseFloat(fresh);
    if (lastKnown !== null) {
      refreshDbSizeInBackground(organizationId);
      return parseFloat(lastKnown);
    }
  } catch {
    // Redis failure — fall through to measuring
  }

  return measureDbSize(organizationId);
}

function refreshDbSizeInBackground(organizationId: string): void {
  const lockKey = `db_size_org_refreshing:${organizationId}`;
  getRedisClient()
    .set(lockKey, '1', 'EX', DB_SIZE_REFRESH_LOCK_TTL_S, 'NX')
    .then((acquired) => {
      if (acquired !== 'OK') return;
      return measureDbSize(organizationId)
        .catch((err) => console.error(`[db-size] background refresh failed for org ${organizationId}:`, err))
        .finally(() => getRedisClient().del(lockKey).catch(() => {}));
    })
    .catch(() => {});
}

/** Measure now: list the org's provisioned apps in every region, size their databases, cache. */
export async function measureDbSize(organizationId: string): Promise<number> {
  // apps + app_db_connections are per-region — gather every region's
  // provisioned apps for this org, then size each data DB.
  const perRegion = await Promise.all(
    Object.keys(config.runtimeDb.urlsByRegion).map((region) =>
      getRuntimeDbPool(config.runtimeDb, region).query<{ id: string; db_name: string; connection_string: string | null }>(
        `SELECT a.id, a.db_name, adc.connection_string
         FROM apps a
         LEFT JOIN app_db_connections adc ON adc.app_id = a.id
         WHERE a.organization_id = $1 AND a.db_provisioned = true`,
        [organizationId]
      )
    )
  );
  const apps = perRegion.flatMap((r) => r.rows).filter((a) => a.connection_string);

  const sizes = await mapWithConcurrency(apps, DB_SIZE_CONCURRENCY, async (app) => {
    let tempPool: Pool | null = null;
    try {
      tempPool = new Pool({
        connectionString: app.connection_string!,
        max: 1,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
      });
      const sizeResult = await tempPool.query('SELECT pg_database_size(current_database()) as size');
      return parseInt(sizeResult.rows[0].size, 10);
    } catch (err) {
      console.error(`Failed to get db size for app ${app.id}:`, err);
      return 0; // Skip this app — don't block the billing page
    } finally {
      if (tempPool) await tempPool.end().catch(() => {});
    }
  });
  const total = sizes.reduce((a, b) => a + b, 0);

  const redis = getRedisClient();
  redis.setex(`db_size_org:${organizationId}`, DB_SIZE_FRESH_TTL_S, total.toString()).catch(() => {});
  redis.setex(`db_size_org_last:${organizationId}`, DB_SIZE_LAST_KNOWN_TTL_S, total.toString()).catch(() => {});
  return total;
}

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface CreditsBalance {
  monthlyAllowanceUsd: number;
  topupUsd: number;
  totalUsd: number;
}

/**
 * Get an organization's credits balance across both pools:
 * the monthly plan allowance and the prepaid top-up balance.
 *
 * Billing is per-org (migration 093). Callers MUST resolve the target org
 * upstream — from request.auth.organizationId, an explicit param, or (for
 * UX defaults on dashboard reads) resolveOrganizationId(userId). The data
 * layer never falls back to personal on its own.
 */
export async function getCreditsBalance(db: DbClient, organizationId: string): Promise<CreditsBalance> {
  const result = await db.query<{ monthly_allowance_usd: string; credits_usd: string }>(
    `SELECT monthly_allowance_usd, credits_usd
     FROM organizations
     WHERE id = $1`,
    [organizationId]
  );
  if (result.rows.length === 0) {
    return { monthlyAllowanceUsd: 0, topupUsd: 0, totalUsd: 0 };
  }
  const monthly = parseFloat(result.rows[0].monthly_allowance_usd);
  const topup = parseFloat(result.rows[0].credits_usd);
  return { monthlyAllowanceUsd: monthly, topupUsd: topup, totalUsd: monthly + topup };
}

/**
 * Atomically deduct from the user's credits balance.
 * Returns the amount actually deducted (may be less than requested if balance is insufficient).
 */
export async function deductCreditsBalance(
  db: DbClient,
  organizationId: string,
  amountUsd: number
): Promise<number> {
  // Per-org (Phase 3b). Caller passes the org whose credit pool to draw from.
  const result = await db.query(
    `UPDATE organizations
     SET credits_usd = GREATEST(0, credits_usd - $1)
     WHERE id = $2
     RETURNING credits_usd`,
    [amountUsd, organizationId]
  );
  if (result.rows.length === 0) return 0;

  // Calculate how much was actually deducted
  const remaining = parseFloat(result.rows[0].credits_usd);
  const balance = remaining + amountUsd; // what it was before

  // Warn the customer if this debit emptied them. This path bypasses the
  // lease subsystem, so the AI router's post-settle hook never sees it —
  // without this, people/apollo/enrichlayer spend could drain an account in
  // silence.
  //
  // Pool only, and the `instanceof` is the whole point: DbClient is
  // `Pool | PoolClient`, and a PoolClient here means we are inside someone
  // else's transaction, where sending mail and stamping a dedup marker would
  // fire for a debit that may still roll back. Fire-and-forget either way —
  // the debit has already happened and must not fail on a notification.
  if (db instanceof Pool) {
    void fireCreditsEmailForOrg(db, organizationId);
  }

  return Math.min(amountUsd, balance); // actual deduction
}

/**
 * Cleanup on shutdown
 * @deprecated Use shutdownRedis() from redis.ts instead. This is now a no-op.
 */
export async function shutdown(): Promise<void> {
  console.warn('[usage-metering] shutdown() is deprecated. Use shutdownRedis() from redis.ts instead.');
}
