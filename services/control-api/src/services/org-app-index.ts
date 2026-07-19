import type pg from 'pg';

export interface OrgAppIndexRow {
  app_id: string;
  organization_id: string;
  region: string;
  subdomain: string | null;
  app_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AddArgs {
  organizationId: string;
  appId: string;
  region: string;
  subdomain?: string;
  appName?: string;
}

export async function addOrgAppIndex(controlPool: pg.Pool, args: AddArgs): Promise<void> {
  await controlPool.query(
    `INSERT INTO org_app_index (app_id, organization_id, region, subdomain, app_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id) DO UPDATE
     SET region = EXCLUDED.region,
         subdomain = COALESCE(EXCLUDED.subdomain, org_app_index.subdomain),
         app_name = COALESCE(EXCLUDED.app_name, org_app_index.app_name),
         updated_at = now()`,
    [args.appId, args.organizationId, args.region, args.subdomain ?? null, args.appName ?? null],
  );
}

export async function removeOrgAppIndex(controlPool: pg.Pool, appId: string): Promise<void> {
  await controlPool.query(`DELETE FROM org_app_index WHERE app_id = $1`, [appId]);
}

export async function updateOrgAppIndexRegion(
  controlPool: pg.Pool,
  appId: string,
  region: string,
): Promise<void> {
  await controlPool.query(
    `UPDATE org_app_index SET region = $2, updated_at = now() WHERE app_id = $1`,
    [appId, region],
  );
}

export async function listUserApps(controlPool: pg.Pool, organizationId: string): Promise<OrgAppIndexRow[]> {
  const r = await controlPool.query<OrgAppIndexRow>(
    `SELECT app_id, organization_id, region, subdomain, app_name, created_at, updated_at
     FROM org_app_index
     WHERE organization_id = $1
     ORDER BY created_at DESC`,
    [organizationId],
  );
  return r.rows;
}

/**
 * List every app in every org the user is a member of. Used by JWT sessions
 * that haven't picked an explicit active org — otherwise a user in multiple
 * orgs sees only their personal-org apps and can't even discover the ids of
 * team-org apps to switch context to. bb_sk_* API keys never call this — they
 * carry an explicit organization_id and stay strictly scoped via listUserApps.
 */
export async function listAppsForUserAcrossOrgs(
  controlPool: pg.Pool,
  userId: string,
): Promise<OrgAppIndexRow[]> {
  const r = await controlPool.query<OrgAppIndexRow>(
    `SELECT i.app_id, i.organization_id, i.region, i.subdomain, i.app_name, i.created_at, i.updated_at
     FROM org_app_index i
     JOIN organization_members m ON m.organization_id = i.organization_id
     WHERE m.user_id = $1
     ORDER BY i.created_at DESC`,
    [userId],
  );
  return r.rows;
}

