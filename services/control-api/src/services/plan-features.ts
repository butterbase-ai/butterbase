import pg from 'pg';
import { getRuntimeDbForApp } from './region-resolver.js';

/**
 * Resolves the plan-gated feature flags available to an app.
 *
 * Plan gate — must read the plan of the APP's owning organization, not the
 * caller's personal_organization_id. For team-org apps, the caller's
 * personal org may be Playground even when the team org paid for Launch
 * (and vice versa — a paid personal org can't reach a team app it's a
 * member of). Fall back to personal_organization_id only for legacy apps
 * with NULL organization_id (pre-backfill), using the app row's owner_id
 * (falling back to fallbackUserId only if the app row itself yields none).
 *
 * Fails open: returns {} when no plan row is found, rather than 403ing.
 * Do not tighten this — it would start 403ing orgs that have never had a
 * plan row.
 *
 * Resolves its own runtime pool via getRuntimeDbForApp so it can be called
 * from handlers that don't already have a runtimeDb in scope. That call can
 * throw AppNotFoundError if the app isn't in org_app_index — this is
 * intentionally left uncaught here; the app's global error handler maps
 * AppNotFoundError to a 404, which is the right response for "gate a
 * feature on an app that doesn't exist."
 */
export async function getAppPlanFeatures(
  controlDb: pg.Pool,
  appId: string,
  fallbackUserId: string,
): Promise<Record<string, unknown>> {
  const runtimeDb = await getRuntimeDbForApp(controlDb, appId);

  const appOrgResult = await runtimeDb.query<{ organization_id: string | null; owner_id: string }>(
    'SELECT organization_id, owner_id FROM apps WHERE id = $1',
    [appId],
  );
  const appOrgId = appOrgResult.rows[0]?.organization_id;
  const planResult = appOrgId
    ? await controlDb.query(
        `SELECT p.features FROM organizations o
         JOIN plans p ON p.id = o.plan_id
         WHERE o.id = $1`,
        [appOrgId],
      )
    : await controlDb.query(
        `SELECT p.features FROM platform_users pu
         JOIN organizations o ON o.id = pu.personal_organization_id
         JOIN plans p ON p.id = o.plan_id
         WHERE pu.id = $1`,
        [appOrgResult.rows[0]?.owner_id ?? fallbackUserId],
      );
  return (planResult.rows[0]?.features as Record<string, unknown>) || {};
}
