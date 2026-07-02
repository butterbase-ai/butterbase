// services/control-api/src/services/usage-metering.ts
import { Pool, PoolClient } from 'pg';
import { getRedisClient } from './redis.js';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { resolveOrganizationId } from './org-resolver.js';

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
  userId: string,
  meterType: MeterType,
  quantity: number = 1,
  appId?: string
): Promise<void> {
  try {
    const periodStart = getCurrentPeriodStart();
    const key = getRedisKey(userId, meterType, periodStart, appId);

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
  userId: string,
  meterType: MeterType,
  appId?: string
): Promise<number> {
  try {
    const periodStart = getCurrentPeriodStart();

    // Get from Redis (hot data)
    const redisKey = getRedisKey(userId, meterType, periodStart, appId);
    const redisValue = await getRedisClient().get(redisKey);
    const redisUsage = redisValue ? parseInt(redisValue, 10) : 0;

    // usage_meters is per-region. When appId is given, hit the app's home
    // region. When not (user-scoped counter — app_id IS NULL), sum across
    // every region since the row could live in any of them.
    let dbUsage = 0;
    if (appId) {
      const runtimePool = await getRuntimeDbForApp(db as Pool, appId);
      const result = await runtimePool.query(
        'SELECT quantity FROM usage_meters WHERE user_id = $1 AND meter_type = $2 AND period_start = $3 AND app_id = $4',
        [userId, meterType, periodStart, appId]
      );
      dbUsage = result.rows.length > 0 ? parseInt(result.rows[0].quantity, 10) : 0;
    } else {
      for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
        const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
        const result = await runtimePool.query(
          'SELECT quantity FROM usage_meters WHERE user_id = $1 AND meter_type = $2 AND period_start = $3 AND app_id IS NULL',
          [userId, meterType, periodStart]
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
    const pattern = 'usage:*';
    const keys = await getRedisClient().keys(pattern);

    if (keys.length === 0) {
      return;
    }

    // usage_meters is per-region. For app-scoped counters, pick the app's
    // home runtime DB. For user-scoped (no app_id), default to us-east-1 —
    // user-scoped meters need consistent placement; getCurrentUsage fans
    // out reads, so the placement region just needs to be stable.
    const eastPool = getRuntimeDbPool(config.runtimeDb, 'us-east-1');

    // Cache org IDs per userId to avoid N lookups for the same user in one batch run.
    const orgIdCache = new Map<string, string>();

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
        if (!runtimePool) continue; // app no longer in user_app_index — drop

        // Resolve org ID (with per-run cache to avoid redundant lookups).
        // resolveOrganizationId throws on missing/corrupt user data — let it
        // propagate to the outer catch, which will re-throw it so the flush
        // worker can surface the corruption rather than silently swallow it.
        if (!orgIdCache.has(parsed.userId)) {
          orgIdCache.set(parsed.userId, await resolveOrganizationId(db, parsed.userId));
        }
        const organizationId = orgIdCache.get(parsed.userId)!;
        const query = `
          INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, app_id, meter_type, period_start)
          DO UPDATE SET quantity = usage_meters.quantity + EXCLUDED.quantity, updated_at = now()
        `;

        try {
          await runtimePool.query(query, [
            parsed.userId,
            organizationId,
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
    const pattern = `usage:*:${appId}:*`;
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
       WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
       GROUP BY app_id`,
      [userId]
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
       WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
         AND DATE(started_at) >= $2
       GROUP BY app_id`,
      [userId, periodStart]
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
       WHERE a.owner_id = $1
         AND au.last_sign_in_at >= $2
       GROUP BY a.id`,
      [userId, periodStart]
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
       WHERE a.owner_id = $1 AND a.db_provisioned = true`,
      [userId]
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

function getRedisKey(userId: string, meterType: MeterType, periodStart: string, appId?: string): string {
  return appId
    ? `usage:${userId}:${appId}:${meterType}:${periodStart}`
    : `usage:${userId}:${meterType}:${periodStart}`;
}

function parseRedisKey(key: string): {
  userId: string;
  appId?: string;
  meterType: MeterType;
  periodStart: string;
} | null {
  const parts = key.split(':');
  if (parts[0] !== 'usage') return null;

  if (parts.length === 5) {
    // With appId
    return {
      userId: parts[1],
      appId: parts[2],
      meterType: parts[3] as MeterType,
      periodStart: parts[4],
    };
  } else if (parts.length === 4) {
    // Without appId
    return {
      userId: parts[1],
      meterType: parts[2] as MeterType,
      periodStart: parts[3],
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
 * Get total AI credits (USD) used by a user for the current billing period.
 * All tiers now use monthly billing periods (V1 pricing).
 * Queries ai_usage_logs directly (source of truth) and caches for 30 seconds.
 * Only counts platform key usage (not BYOK).
 */
export async function getAiCreditsUsed(db: DbClient, userId: string, lifetime: boolean = false): Promise<number> {
  const periodStart = getCurrentPeriodStart();
  const cacheKey = lifetime
    ? `ai_credits_lifetime:${userId}`
    : `ai_credits:${userId}:${periodStart}`;

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
           WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
             AND key_type = 'platform'`,
          [userId]
        )
      : await runtimePool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total
           FROM ai_usage_logs
           WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
             AND key_type = 'platform'
             AND DATE(created_at) >= $2`,
          [userId, periodStart]
        );
    total += parseFloat(result.rows[0].total);
  }

  getRedisClient().setex(cacheKey, 30, total.toString()).catch(() => {});
  return total;
}

/**
 * Get total storage bytes used across all apps owned by a user.
 * Queries storage_objects directly (source of truth) and caches for 30 seconds.
 */
export async function getStorageUsed(db: DbClient, userId: string): Promise<number> {
  const cacheKey = `storage_used:${userId}`;

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
       WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)`,
      [userId]
    );
    total += parseFloat(result.rows[0].total);
  }

  getRedisClient().setex(cacheKey, 30, total.toString()).catch(() => {});
  return total;
}

/**
 * Get monthly active users (MAU) across all apps owned by a user.
 * Counts distinct app_users who signed in during the current billing period.
 * Queries app_users directly (source of truth) and caches for 60 seconds.
 */
export async function getMAU(db: DbClient, userId: string): Promise<number> {
  const periodStart = getCurrentPeriodStart();
  const cacheKey = `mau:${userId}:${periodStart}`;

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
       WHERE au.app_id IN (SELECT id FROM apps WHERE owner_id = $1)
         AND au.last_sign_in_at >= $2`,
      [userId, periodStart]
    );
    total += parseInt(result.rows[0].total, 10);
  }

  getRedisClient().setex(cacheKey, 60, total.toString()).catch(() => {});
  return total;
}

/**
 * Get total database size (bytes) across all provisioned app databases for a user.
 * Connects to each app's database to run pg_database_size (source of truth).
 * Caches for 300 seconds (5 minutes) since this is an expensive operation.
 */
export async function getDbSize(db: DbClient, userId: string): Promise<number> {
  const cacheKey = `db_size:${userId}`;

  try {
    const cached = await getRedisClient().get(cacheKey);
    if (cached !== null) return parseFloat(cached);
  } catch {
    // Redis failure — fall through to DB query
  }

  // apps + app_db_connections are per-region — gather every region's
  // provisioned apps for this owner, then size each data DB.
  const allApps: Array<{ id: string; db_name: string; connection_string: string | null }> = [];
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const appsResult = await runtimePool.query<{ id: string; db_name: string; connection_string: string | null }>(
      `SELECT a.id, a.db_name, adc.connection_string
       FROM apps a
       LEFT JOIN app_db_connections adc ON adc.app_id = a.id
       WHERE a.owner_id = $1 AND a.db_provisioned = true`,
      [userId]
    );
    allApps.push(...appsResult.rows);
  }

  let total = 0;

  for (const app of allApps) {
    if (!app.connection_string) continue;

    let tempPool: Pool | null = null;
    try {
      tempPool = new Pool({
        connectionString: app.connection_string,
        max: 1,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
      });
      const sizeResult = await tempPool.query(
        'SELECT pg_database_size(current_database()) as size'
      );
      total += parseInt(sizeResult.rows[0].size, 10);
    } catch (err) {
      console.error(`Failed to get db size for app ${app.id}:`, err);
      // Skip this app — don't block the billing page
    } finally {
      if (tempPool) {
        await tempPool.end().catch(() => {});
      }
    }
  }

  getRedisClient().setex(cacheKey, 300, total.toString()).catch(() => {});
  return total;
}

export interface CreditsBalance {
  monthlyAllowanceUsd: number;
  topupUsd: number;
  totalUsd: number;
}

/**
 * Get the user's current credits balance across both pools:
 * the monthly plan allowance and the prepaid top-up balance.
 */
export async function getCreditsBalance(db: DbClient, userId: string): Promise<CreditsBalance> {
  const result = await db.query<{ monthly_allowance_usd: string; credits_usd: string }>(
    'SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1',
    [userId]
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
  userId: string,
  amountUsd: number
): Promise<number> {
  const result = await db.query(
    `UPDATE platform_users
     SET credits_usd = GREATEST(0, credits_usd - $1)
     WHERE id = $2
     RETURNING credits_usd`,
    [amountUsd, userId]
  );
  if (result.rows.length === 0) return 0;

  // Calculate how much was actually deducted
  const remaining = parseFloat(result.rows[0].credits_usd);
  const balance = remaining + amountUsd; // what it was before
  return Math.min(amountUsd, balance); // actual deduction
}

/**
 * Cleanup on shutdown
 * @deprecated Use shutdownRedis() from redis.ts instead. This is now a no-op.
 */
export async function shutdown(): Promise<void> {
  console.warn('[usage-metering] shutdown() is deprecated. Use shutdownRedis() from redis.ts instead.');
}
