import type pg from 'pg';
import { getEnvironmentLink, getLinkByStagingApp } from '../app-environments.js';

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

interface CheckOptions {
  sourceRegion?: string;
  /**
   * The app's regional runtime pool. When supplied, the app is also checked for
   * a staging link and the move is refused if one exists.
   *
   * `app_environments` FKs BOTH apps inside ONE regional runtime DB (see
   * runtime-plane/052), so a link cannot follow a single app across regions —
   * the other end would not exist there. The alternatives to refusing are all
   * worse: moving the row breaks its FK, and leaving it behind orphans a
   * staging app that holds a full copy of production's data, keeps billing, and
   * no longer appears in any status the owner can see. Refusing is the only
   * option that does not lose something silently.
   *
   * Optional so existing callers and tests keep working; the route passes it.
   */
  runtimeDb?: pg.Pool;
}

export async function checkMoveAppEligibility(
  controlPool: pg.Pool,
  appId: string,
  destRegion: string,
  opts: CheckOptions = {},
): Promise<EligibilityResult> {
  const r = await controlPool.query<{ plan_id: string | null; active_count: number; region: string }>(
    // Post-Plan-07: plan_id lives on organizations. Resolve via
    // org_app_index.organization_id.
    `SELECT o.plan_id,
            oai.region,
            (SELECT count(*)::int FROM app_migrations am
             WHERE am.app_id = oai.app_id
               AND am.current_step NOT IN ('completed','aborted','failed')) AS active_count
     FROM org_app_index oai
     JOIN organizations o ON o.id = oai.organization_id
     WHERE oai.app_id = $1`,
    [appId],
  );

  if (r.rows.length === 0) {
    return { ok: false, reason: 'App not found in org_app_index.' };
  }
  const row = r.rows[0];
  const source = opts.sourceRegion ?? row.region;
  if (source === destRegion) {
    return { ok: false, reason: 'Source and destination regions are equal.' };
  }
  if (row.plan_id === null) {
    return { ok: false, reason: 'Owner has no active plan.' };
  }
  if (row.active_count > 0) {
    return { ok: false, reason: 'A migration is already in flight for this app.' };
  }

  // Checked last: it is the only check that needs a second database, and the
  // cheap disqualifiers above should short-circuit before we pay for it.
  if (opts.runtimeDb) {
    const asProduction = await getEnvironmentLink(opts.runtimeDb, appId);
    if (asProduction) {
      return {
        ok: false,
        reason:
          `This app has a staging environment (${asProduction.staging_app_id}), which lives in the `
          + 'same region and cannot move with it. Delete or unlink the staging environment first, '
          + 'then move the app.',
      };
    }
    const asStaging = await getLinkByStagingApp(opts.runtimeDb, appId);
    if (asStaging) {
      return {
        ok: false,
        reason:
          `This app is the staging environment for ${asStaging.prod_app_id} and must stay in the `
          + 'same region as it. Unlink it first, then move it.',
      };
    }
  }

  return { ok: true };
}
