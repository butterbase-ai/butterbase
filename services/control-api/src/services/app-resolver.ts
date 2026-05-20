import { Pool } from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';

/**
 * Resolve the app's home region from the cross-region user_app_index on
 * the control DB. Returns null when the app isn't indexed. Callers that
 * need the per-region runtime DB should look up the region here first.
 */
async function resolveHomeRegion(controlPool: Pool, appId: string): Promise<string | null> {
  const r = await controlPool.query<{ region: string }>(
    `SELECT region FROM user_app_index WHERE app_id = $1`,
    [appId]
  );
  return r.rows[0]?.region ?? null;
}

export class AppNotFoundError extends Error {
  constructor(appId: string) {
    super(`App not found: ${appId}`);
    this.name = 'AppNotFoundError';
  }
}

export class AppAuthRequiredError extends Error {
  constructor(appId: string) {
    super(`App ${appId} requires authentication`);
    this.name = 'AppAuthRequiredError';
  }
}

export class AppPausedError extends Error {
  reason: string | null;
  constructor(appId: string, reason: string | null) {
    super(`App ${appId} is paused${reason ? `: ${reason}` : ''}`);
    this.name = 'AppPausedError';
    this.reason = reason;
  }
}

interface PausableApp {
  id: string;
  paused?: boolean;
  paused_reason?: string | null;
}

/**
 * Throws AppPausedError if the resolved app has been paused via the
 * pause_app kill-switch. Call this in data-plane entry points right after
 * AppResolver.resolveApp / resolveAppPublic. Control-plane endpoints (config
 * mutations, the unpause toggle) intentionally do not call this.
 */
export function assertAppNotPaused(app: PausableApp): void {
  if (app.paused) {
    throw new AppPausedError(app.id, app.paused_reason ?? null);
  }
}

export class AppResolver {
  /**
   * Resolve an app by ID with ownership check
   * Throws AppNotFoundError if app doesn't exist or user doesn't own it
   */
  static async resolveApp(
    controlPool: Pool,
    appId: string,
    userId: string
  ): Promise<{ id: string; name: string; owner_id: string; db_name: string; paused: boolean; paused_reason: string | null }> {
    const region = await resolveHomeRegion(controlPool, appId);
    if (!region) throw new AppNotFoundError(appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimeDb.query(
      `SELECT id, name, owner_id, db_name, paused, paused_reason
       FROM apps
       WHERE id = $1 AND owner_id = $2`,
      [appId, userId]
    );

    if (result.rows.length === 0) {
      throw new AppNotFoundError(appId);
    }

    return result.rows[0];
  }

  /**
   * Resolve an app by ID without ownership check (for anonymous/public access)
   * Throws AppNotFoundError if app doesn't exist or isn't provisioned
   */
  static async resolveAppPublic(
    controlPool: Pool,
    appId: string
  ): Promise<{ id: string; db_name: string; access_mode: string; paused: boolean; paused_reason: string | null }> {
    const region = await resolveHomeRegion(controlPool, appId);
    if (!region) throw new AppNotFoundError(appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
    const result = await runtimeDb.query(
      `SELECT id, db_name, access_mode, paused, paused_reason
       FROM apps
       WHERE id = $1 AND db_provisioned = true`,
      [appId]
    );

    if (result.rows.length === 0) {
      throw new AppNotFoundError(appId);
    }

    return result.rows[0];
  }
}
