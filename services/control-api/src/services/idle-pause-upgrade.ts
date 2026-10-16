// Upgrading off an idle-pause plan brings back the apps the idle reaper
// paused (spec §5.7). Owner, admin and staging pauses are left alone; the
// paused_by check is inside the resume UPDATE, so a pause that lands
// between the lookup and the resume can't be undone by this.
// Called post-COMMIT from every plan-change path; never throws.
import type pg from 'pg';
import { config } from '../config.js';
import { setPausedState, type PauseLogger } from './app-pause.js';
import { idlePausePlansFromEnv } from './idle-pause-config.js';
import { getRuntimeDbPool } from './runtime-db.js';

export async function resumeIdlePausedAppsForOrg(
  controlDb: Pick<pg.Pool, 'query'>,
  orgId: string,
  newPlanId: string | null | undefined,
  log?: PauseLogger,
): Promise<string[]> {
  if (!newPlanId || idlePausePlansFromEnv().includes(newPlanId)) return [];
  const resumed: string[] = [];
  let apps: { app_id: string; region: string }[];
  try {
    apps = (await controlDb.query(
      `SELECT app_id, region FROM org_app_index WHERE organization_id = $1`, [orgId],
    )).rows;
  } catch (err) {
    log?.error({ err, orgId }, '[idle-pause] upgrade auto-resume: app lookup failed');
    return resumed;
  }
  for (const { app_id, region } of apps) {
    try {
      const state = await setPausedState(
        getRuntimeDbPool(config.runtimeDb, region), app_id,
        { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, log,
      );
      if (state) resumed.push(app_id);
    } catch (err) {
      log?.error({ err, appId: app_id, orgId }, '[idle-pause] upgrade auto-resume failed');
    }
  }
  return resumed;
}
