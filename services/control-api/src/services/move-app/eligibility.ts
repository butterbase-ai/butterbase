import type pg from 'pg';

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

interface CheckOptions {
  sourceRegion?: string;
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
  return { ok: true };
}
