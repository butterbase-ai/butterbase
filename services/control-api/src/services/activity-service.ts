import type { Pool } from 'pg';

/**
 * Called when a platform user logs in. Sets both last_login_at and
 * last_activity_at to NOW() and increments today's action_count.
 * Fire-and-forget safe: failures are logged but never thrown.
 */
export async function recordPlatformUserLogin(controlDb: Pool, userId: string): Promise<void> {
  try {
    const result = await controlDb.query(
      `UPDATE platform_users
         SET last_login_at = NOW(), last_activity_at = NOW()
         WHERE id = $1
           AND (last_login_at IS NULL OR last_login_at < NOW() - INTERVAL '5 minutes')`,
      [userId],
    );
    if (result.rowCount === 0) return; // throttled OR user gone → skip the daily bump
    await controlDb.query(
      `INSERT INTO platform_user_activity_daily(user_id, day, action_count)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (user_id, day) DO UPDATE
         SET action_count = platform_user_activity_daily.action_count + 1`,
      [userId],
    );
  } catch (error) {
    console.error('[ACTIVITY] Failed to record login for user %s:', userId, error);
  }
}

/**
 * Called for any other meaningful platform-user action. Sets last_activity_at
 * to NOW() and increments today's action_count. No-op if the user row is gone.
 * Fire-and-forget safe: failures are logged but never thrown.
 */
export async function recordPlatformUserAction(controlDb: Pool, userId: string): Promise<void> {
  try {
    await controlDb.query(
      `UPDATE platform_users SET last_activity_at = NOW() WHERE id = $1`,
      [userId],
    );
    await controlDb.query(
      `INSERT INTO platform_user_activity_daily (user_id, day, action_count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (user_id, day) DO UPDATE
         SET action_count = platform_user_activity_daily.action_count + 1`,
      [userId],
    );
  } catch (error) {
    console.error('[ACTIVITY] Failed to record action for user %s:', userId, error);
  }
}

/**
 * Called for any meaningful action by an end-user (app_user). Sets
 * last_activity_at to NOW() and increments today's action_count in
 * app_user_activity_daily. No-op if the user row is gone. Fire-and-forget:
 * failures are logged with [ACTIVITY] prefix and swallowed.
 *
 * Note: last_sign_in_at is already maintained by services/auth/user-service.ts
 * on login. This function only touches last_activity_at + the daily rollup.
 */
export async function recordAppUserAction(runtimeDb: Pool, appUserId: string): Promise<void> {
  try {
    const { rows } = await runtimeDb.query<{ app_id: string }>(
      `UPDATE app_users SET last_activity_at = NOW() WHERE id = $1 RETURNING app_id`,
      [appUserId],
    );
    if (rows.length === 0) {
      return;
    }
    const appId = rows[0]!.app_id;
    await runtimeDb.query(
      `INSERT INTO app_user_activity_daily(app_id, app_user_id, day, action_count)
       VALUES ($1, $2, CURRENT_DATE, 1)
       ON CONFLICT (app_user_id, day) DO UPDATE
         SET action_count = app_user_activity_daily.action_count + 1`,
      [appId, appUserId],
    );
  } catch (error) {
    console.error('[ACTIVITY] Failed to record app-user action for %s:', appUserId, error);
  }
}
