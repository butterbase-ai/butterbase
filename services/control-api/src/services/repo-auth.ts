import type { Pool } from 'pg';
import { AppResolver, AppNotFoundError } from './app-resolver.js';
import { resolveAppHomeRegion } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { config } from '../config.js';

export interface RepoReadContext {
  appId: string;
  region: string;
  visibility: 'public' | 'private';
  isOwner: boolean;
}

/**
 * Authorize a repo read.
 *  - If caller is the owner, allow.
 *  - Else, allow only if the app is `visibility='public'`.
 *  - In both deny paths, throw AppNotFoundError so the route returns 404 (don't leak existence).
 */
export async function authorizeRepoRead(
  controlDb: Pool,
  appId: string,
  requestUserId: string | null,
): Promise<RepoReadContext> {
  const region = await resolveAppHomeRegion(controlDb, appId).catch(() => null);
  if (!region) throw new AppNotFoundError(appId);

  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const res = await runtimeDb.query<{ id: string; owner_id: string; visibility: 'public' | 'private' }>(
    `SELECT id, owner_id, visibility FROM apps WHERE id = $1`,
    [appId],
  );
  if (res.rows.length === 0) throw new AppNotFoundError(appId);
  const row = res.rows[0];

  // Try org-aware auth if user is authenticated
  if (requestUserId) {
    try {
      await AppResolver.resolveApp(controlDb, appId, requestUserId);
      return { appId, region, visibility: row.visibility, isOwner: true };
    } catch (err) {
      if (!(err instanceof AppNotFoundError)) throw err;
      // Not owner/org-member — fall through to public check
    }
  }

  if (row.visibility === 'public') {
    return { appId, region, visibility: 'public', isOwner: false };
  }
  throw new AppNotFoundError(appId);
}

/**
 * Owner-only repo write authorization.
 */
export async function authorizeRepoWrite(
  controlDb: Pool,
  appId: string,
  requestUserId: string,
): Promise<RepoReadContext> {
  const resolved = await AppResolver.resolveApp(controlDb, appId, requestUserId);
  const region = await resolveAppHomeRegion(controlDb, resolved.id);
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const res = await runtimeDb.query<{ visibility: 'public' | 'private' }>(
    `SELECT visibility FROM apps WHERE id = $1`,
    [resolved.id],
  );
  const visibility = res.rows[0]?.visibility ?? 'private';
  return { appId: resolved.id, region, visibility, isOwner: true };
}
