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
  activeOrganizationId: string | null = null,
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
      await AppResolver.resolveApp(controlDb, appId, requestUserId, activeOrganizationId);
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
 * Repo authorization for the AUTONOMOUS OPERATOR's in-process path.
 *
 * The operator has no human identity — it runs as the `operator:<orgId>`
 * sentinel from operator-store.ts, which is not a Cognito sub and appears in no
 * `organization_members` row. So neither authorizer above applies:
 * `authorizeRepoWrite` would resolve nothing for that user id, and
 * `authorizeRepoRead` with a null user takes the public-visibility fallthrough.
 *
 * This one asks the single question the operator identity can actually answer:
 * does the app belong to the org this turn is running for? That is exactly
 * branch 1 of `AppResolver.resolveApp` ("app in caller's active org"), with the
 * `owner_id` match and the membership enumeration deliberately dropped — the
 * sentinel can satisfy neither, so including them would be dead code that
 * merely looks permissive.
 *
 * NO PUBLIC-VISIBILITY FALLTHROUGH, unlike `authorizeRepoRead`. This function
 * gates a path that both hydrates AND flushes, and the operator runs unattended
 * on an org service key with no human watching. Letting it hydrate some other
 * org's public app would put that org's files in this org's working tree, one
 * flush away from being written back out. `visibility` is returned only because
 * `RepoReadContext` carries it; it decides nothing here. Pinned by
 * __tests__/repo-auth-operator.test.ts.
 *
 * `operatorOrgId` is null for the degenerate `operator:` sentinel with no org
 * (see `operatorOrgIdFromUserId`). That denies everything, before any query —
 * an unknown org must not even be able to probe which app ids exist.
 *
 * The region lookup hits `org_app_index` DIRECTLY rather than going through
 * `resolveAppHomeRegion`. Same table, same answer, but that helper reaches for
 * `getRedisClient()`, which eagerly opens a connection on first use; this
 * function is called from inside the dashboard-agent loop, whose unit tests run
 * with no Redis. One uncached control-plane query per operator turn is a fair
 * price for not dragging a live socket into that path.
 */
export async function authorizeOperatorRepo(
  controlDb: Pool,
  appId: string,
  operatorOrgId: string | null,
): Promise<RepoReadContext> {
  if (!operatorOrgId) throw new AppNotFoundError(appId);

  const idx = await controlDb.query<{ region: string }>(
    `SELECT region FROM org_app_index WHERE app_id = $1`,
    [appId],
  );
  const region = idx.rows[0]?.region;
  if (!region) throw new AppNotFoundError(appId);

  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const res = await runtimeDb.query<{ organization_id: string | null; visibility: 'public' | 'private' }>(
    `SELECT organization_id, visibility FROM apps WHERE id = $1`,
    [appId],
  );
  const row = res.rows[0];
  if (!row) throw new AppNotFoundError(appId);
  if (!row.organization_id || row.organization_id !== operatorOrgId) {
    throw new AppNotFoundError(appId);
  }

  return { appId, region, visibility: row.visibility, isOwner: true };
}

/**
 * Owner-only repo write authorization.
 */
export async function authorizeRepoWrite(
  controlDb: Pool,
  appId: string,
  requestUserId: string,
  activeOrganizationId: string | null = null,
): Promise<RepoReadContext> {
  const resolved = await AppResolver.resolveApp(controlDb, appId, requestUserId, activeOrganizationId);
  const region = await resolveAppHomeRegion(controlDb, resolved.id);
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const res = await runtimeDb.query<{ visibility: 'public' | 'private' }>(
    `SELECT visibility FROM apps WHERE id = $1`,
    [resolved.id],
  );
  const visibility = res.rows[0]?.visibility ?? 'private';
  return { appId: resolved.id, region, visibility, isOwner: true };
}
