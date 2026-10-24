// Upgrading off an idle-pause plan brings back the apps the idle reaper
// paused (spec §5.7). Owner, admin and staging pauses are left alone; the
// paused_by check is inside the resume UPDATE, so a pause that lands
// between the lookup and the resume can't be undone by this.
// Called post-COMMIT from every plan-change path; never throws.
import type pg from 'pg';
import { config } from '../config.js';
import { setPausedState, notifyPauseStateChanged, type PauseLogger } from './app-pause.js';
import { idlePausePlansFromEnv } from './idle-pause-config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { lockAppStates } from './app-state-lock.js';

export async function resumeIdlePausedAppsForOrg(
  controlDb: Pick<pg.Pool, 'query' | 'connect'>,
  orgId: string,
  newPlanId: string | null | undefined,
  log?: PauseLogger,
): Promise<string[]> {
  if (!newPlanId || idlePausePlansFromEnv().includes(newPlanId)) return [];
  for (let attempt=0; attempt<3; attempt++) {
    const result = await resumeAttempt(controlDb,orgId,log);
    if (!result.retry || attempt===2) return result.resumed;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return [];
}

async function resumeAttempt(
  controlDb: Pick<pg.Pool,'query'|'connect'>, orgId: string, log?: PauseLogger,
): Promise<{ resumed:string[];retry:boolean }> {
  const resumed: string[] = [];
  let retry = false;
  let client: pg.PoolClient | undefined;
  try {
    client = await controlDb.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    // A webhook's proposed plan can already be stale. Hold a shared row lock
    // through runtime writes so a concurrent downgrade cannot commit between
    // the current-plan check and the UPDATEs. External effects run after release.
    const current = await client.query<{ plan_id: string | null }>(
      'SELECT plan_id FROM organizations WHERE id = $1 FOR SHARE', [orgId],
    );
    const plan = current.rows[0]?.plan_id;
    if (plan && !idlePausePlansFromEnv().includes(plan)) {
      const apps = (await client.query<{ app_id: string; region: string }>(
        `SELECT app_id, region FROM org_app_index WHERE organization_id = $1`, [orgId],
      )).rows;
      // Re-read canonical homes after acquiring the same app locks as cutover.
      const locked = await lockAppStates(client, apps.map(a => a.app_id));
      for (const { app_id, region, organization_id } of locked) {
        if (organization_id !== orgId) continue;
        try {
          const state = await setPausedState(
            getRuntimeDbPool(config.runtimeDb, region), app_id,
            { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, log, { notify: false },
          );
          if (state) resumed.push(app_id);
        } catch (err) {
          log?.error({ err, appId: app_id, orgId }, '[idle-pause] upgrade auto-resume failed');
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    retry = (err as { code?:string }).code === '55P03';
    log?.error({ err, orgId }, '[idle-pause] upgrade auto-resume: app lookup failed');
  } finally {
    client?.release();
  }
  for (const appId of resumed) {
    await notifyPauseStateChanged({ appId, paused: false, by: 'system' }, log);
  }
  return { resumed,retry };
}
