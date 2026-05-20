import type { Pool } from 'pg';
import type { AppUser } from '@butterbase/shared/types';
import { getRuntimeDbForApp } from '../region-resolver.js';

/**
 * All functions here operate on per-app rows in `app_users` (a runtime
 * table). Each one takes the control DB pool + appId so it can resolve
 * the app's home region from user_app_index and write/read against the
 * correct regional runtime DB. A us-east-1 machine handling a us-west-2
 * app must hit the us-west-2 runtime DB, not its own.
 */

/**
 * Creates a new app user
 */
export async function createUser(
  controlPool: Pool,
  appId: string,
  email: string,
  passwordHash: string | null,
  displayName?: string
): Promise<AppUser> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `INSERT INTO app_users (app_id, email, password_hash, provider, display_name)
     VALUES ($1, $2, $3, 'email', $4)
     RETURNING *`,
    [appId, email, passwordHash, displayName || null]
  );

  return result.rows[0];
}

/**
 * Gets a user by email and app_id
 */
export async function getUserByEmail(
  controlPool: Pool,
  appId: string,
  email: string
): Promise<AppUser | null> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `SELECT * FROM app_users
     WHERE app_id = $1 AND email = $2 AND provider = 'email'`,
    [appId, email]
  );

  return result.rows[0] || null;
}

/**
 * Gets a user by ID, scoped to a specific app (so we hit the right region's
 * runtime DB).
 */
export async function getUserById(
  controlPool: Pool,
  appId: string,
  userId: string
): Promise<AppUser | null> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `SELECT * FROM app_users WHERE id = $1 AND app_id = $2`,
    [userId, appId]
  );

  return result.rows[0] || null;
}

/**
 * Updates user's last sign-in timestamp
 */
export async function updateLastSignIn(
  controlPool: Pool,
  appId: string,
  userId: string
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  await runtimePool.query(
    `UPDATE app_users SET last_sign_in_at = now() WHERE id = $1 AND app_id = $2`,
    [userId, appId]
  );
}

/**
 * Marks user's email as verified
 */
export async function markEmailVerified(
  controlPool: Pool,
  appId: string,
  userId: string
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  await runtimePool.query(
    `UPDATE app_users SET email_verified = true WHERE id = $1 AND app_id = $2`,
    [userId, appId]
  );
}

/**
 * Updates user's password
 */
export async function updatePassword(
  controlPool: Pool,
  appId: string,
  userId: string,
  passwordHash: string
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  await runtimePool.query(
    `UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2 AND app_id = $3`,
    [passwordHash, userId, appId]
  );
}
