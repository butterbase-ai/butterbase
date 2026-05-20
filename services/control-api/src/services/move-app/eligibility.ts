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
    `SELECT pu.plan_id,
            uai.region,
            (SELECT count(*)::int FROM app_migrations am
             WHERE am.app_id = uai.app_id
               AND am.current_step NOT IN ('completed','aborted','failed')) AS active_count
     FROM user_app_index uai
     JOIN platform_users pu ON pu.id = uai.user_id
     WHERE uai.app_id = $1`,
    [appId],
  );

  if (r.rows.length === 0) {
    return { ok: false, reason: 'App not found in user_app_index.' };
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
