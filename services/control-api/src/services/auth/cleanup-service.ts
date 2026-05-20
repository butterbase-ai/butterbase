import type { Pool } from 'pg';
import { config } from '../../config.js';
import { getRuntimeDbPool } from '../runtime-db.js';
import { cleanupExpiredOAuthStates } from './oauth-state-service.js';

/**
 * Fan out a DELETE across every configured region's runtime DB and sum the
 * affected-row counts. All three cleanup tasks below operate on per-region
 * auth tables, so we visit each region rather than just this machine's.
 */
async function forEachRegion(query: string): Promise<number> {
  let total = 0;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimePool.query(query);
    total += result.rowCount || 0;
  }
  return total;
}

/**
 * Deletes expired and used verification codes older than 7 days
 */
export async function cleanupVerificationCodes(_db: Pool): Promise<number> {
  return forEachRegion(
    `DELETE FROM app_verification_codes
     WHERE (used_at IS NOT NULL OR expires_at < now())
     AND created_at < now() - interval '7 days'`
  );
}

/**
 * Deletes revoked refresh tokens older than 30 days
 */
export async function cleanupRefreshTokens(_db: Pool): Promise<number> {
  return forEachRegion(
    `DELETE FROM app_refresh_tokens
     WHERE revoked_at IS NOT NULL
     AND revoked_at < now() - interval '30 days'`
  );
}

/**
 * Deletes expired refresh tokens (not revoked, just expired)
 */
export async function cleanupExpiredRefreshTokens(_db: Pool): Promise<number> {
  return forEachRegion(
    `DELETE FROM app_refresh_tokens
     WHERE expires_at < now()
     AND revoked_at IS NULL`
  );
}

/**
 * Runs all cleanup tasks
 */
export async function runCleanup(db: Pool): Promise<void> {
  const codesDeleted = await cleanupVerificationCodes(db);
  const revokedTokensDeleted = await cleanupRefreshTokens(db);
  const expiredTokensDeleted = await cleanupExpiredRefreshTokens(db);
  const oauthStatesDeleted = await cleanupExpiredOAuthStates(db);

  console.log(
    `[CLEANUP] Deleted ${codesDeleted} verification codes, ` +
    `${revokedTokensDeleted} revoked tokens, ` +
    `${expiredTokensDeleted} expired tokens, ` +
    `${oauthStatesDeleted} OAuth states`
  );
}
