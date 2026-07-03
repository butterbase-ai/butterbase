import type { Pool } from 'pg';

import { getRuntimeDbForApp } from './region-resolver.js';
import { getRedisClient } from './redis.js';
import {
  getPlanLimits,
  FREE_PLAN_DEFAULTS,
  type PlanLimits,
} from '../plugins/quota-enforcement.js';

const APP_LIMITS_TTL = 60;

export async function getLimitsForApp(
  controlDb: Pool,
  appId: string
): Promise<PlanLimits> {
  const redis = getRedisClient();
  const cacheKey = `app:${appId}:limits`;

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as PlanLimits;
    } catch {
      // fall through to DB lookup
    }
  }

  let planId = 'playground';
  try {
    const runtimeDb = await getRuntimeDbForApp(controlDb, appId);

    // Step 1: get owner_id from runtime DB (apps is a runtime-tier table)
    const appRow = await runtimeDb.query<{ owner_id: string }>(
      'SELECT owner_id FROM apps WHERE id = $1',
      [appId]
    );
    if (appRow.rows.length > 0 && appRow.rows[0].owner_id) {
      const ownerId = appRow.rows[0].owner_id;
      // Step 2: get plan_id from the owner's personal org (Plan 07 moved
      // plan_id from platform_users to organizations).
      const userRow = await controlDb.query<{ plan_id: string }>(
        `SELECT o.plan_id
         FROM platform_users pu
         JOIN organizations o ON o.id = pu.personal_organization_id
         WHERE pu.id = $1`,
        [ownerId]
      );
      if (userRow.rows.length > 0 && userRow.rows[0].plan_id) {
        planId = userRow.rows[0].plan_id;
      }
    }
  } catch {
    return FREE_PLAN_DEFAULTS;
  }

  const limits = await getPlanLimits(controlDb, planId).catch(
    () => FREE_PLAN_DEFAULTS
  );

  await redis
    .setex(cacheKey, APP_LIMITS_TTL, JSON.stringify(limits))
    .catch(() => {});

  return limits;
}

export async function invalidateAppLimits(appId: string): Promise<void> {
  await getRedisClient()
    .del(`app:${appId}:limits`)
    .catch(() => {});
}

/**
 * Invalidate cached app-limits for every app owned by `userId`.
 * Call this whenever a user's `plan_id` changes (upgrade, downgrade, sponsor code).
 */
export async function invalidateUserAppLimits(
  controlDb: Pool,
  userId: string
): Promise<void> {
  try {
    // org_app_index is the cross-region map of (org → apps).
    const { rows } = await controlDb.query<{ app_id: string }>(
      `SELECT oai.app_id
       FROM org_app_index oai
       JOIN platform_users pu ON pu.personal_organization_id = oai.organization_id
       WHERE pu.id = $1`,
      [userId]
    );
    if (rows.length === 0) return;
    const redis = getRedisClient();
    await Promise.all(
      rows.map((r) => redis.del(`app:${r.app_id}:limits`).catch(() => 0))
    );
  } catch {
    // Non-fatal: cache will expire within APP_LIMITS_TTL regardless.
  }
}
