import type { Pool } from 'pg';
import { nanoid } from 'nanoid';
import { config } from '../../config.js';
import { getRuntimeDbForApp } from '../region-resolver.js';
import { getRuntimeDbPool } from '../runtime-db.js';

export interface OAuthState {
  state: string;
  appId: string;
  provider: string;
  redirectTo?: string;
  codeVerifier?: string;
  expiresAt: Date;
}

/**
 * Creates a new OAuth state token in the app's home-region runtime DB.
 */
export async function createOAuthState(
  controlPool: Pool,
  appId: string,
  provider: string,
  redirectTo?: string,
  codeVerifier?: string
): Promise<string> {
  const state = nanoid(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);

  await runtimePool.query(
    `INSERT INTO oauth_states (state, app_id, provider, redirect_to, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [state, appId, provider, redirectTo, codeVerifier, expiresAt]
  );

  return state;
}

/**
 * Validates and consumes an OAuth state token. Takes appId because oauth_states
 * is per-region — the state alone doesn't tell us which region's DB to hit.
 * Callers receive appId from the URL params on /auth/:app_id/oauth/callback.
 */
export async function consumeOAuthState(
  controlPool: Pool,
  appId: string,
  state: string
): Promise<OAuthState | null> {
  const runtimePool = await getRuntimeDbForApp(controlPool, appId);
  const result = await runtimePool.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND app_id = $2 AND expires_at > now()
     RETURNING state, app_id, provider, redirect_to, code_verifier, expires_at`,
    [state, appId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    state: result.rows[0].state,
    appId: result.rows[0].app_id,
    provider: result.rows[0].provider,
    redirectTo: result.rows[0].redirect_to,
    codeVerifier: result.rows[0].code_verifier,
    expiresAt: result.rows[0].expires_at,
  };
}

/**
 * Cleans up expired OAuth states across every configured region.
 * Runs as a background cron — operates on all per-region runtime DBs.
 */
export async function cleanupExpiredOAuthStates(_db: Pool): Promise<number> {
  let total = 0;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimePool.query(
      `DELETE FROM oauth_states WHERE expires_at < now()`
    );
    total += result.rowCount || 0;
  }
  return total;
}
