import type pg from 'pg';
import type { PauseLogger } from './app-pause.js';
import { idlePausePlansFromEnv } from './idle-pause-config.js';
import { resumeIdlePausedAppsForOrg } from './idle-pause-upgrade.js';

type ControlDb = Pick<pg.Pool, 'query' | 'connect'>;

/** The persisted paid plan is the recovery intent. Scan it independently of
 * the opt-in idle reaper so missed post-commit hooks survive process restarts.
 * The resume helper rechecks the current plan and canonical homes under locks.
 */
export async function reconcileIdlePausedUpgrades(
  controlDb: ControlDb, after?: string, log?: PauseLogger, batchSize = 25, signal?: AbortSignal,
): Promise<string | undefined> {
  const { rows } = await controlDb.query<{ id: string; plan_id: string }>(
    `SELECT o.id, o.plan_id FROM organizations o
      WHERE ($1::uuid IS NULL OR o.id > $1::uuid)
        AND o.plan_id IS NOT NULL AND NOT (o.plan_id = ANY($2::text[]))
        AND EXISTS (SELECT 1 FROM org_app_index a WHERE a.organization_id = o.id)
      ORDER BY o.id LIMIT $3`,
    [after ?? null, idlePausePlansFromEnv(), batchSize],
  );
  for (const org of rows) {
    if (signal?.aborted) return undefined;
    await resumeIdlePausedAppsForOrg(controlDb, org.id, org.plan_id, log);
  }
  return rows.length === batchSize ? rows.at(-1)?.id : undefined;
}

export function startIdlePauseUpgradeReconciler(
  controlDb: ControlDb, log: PauseLogger, intervalMs = 5 * 60_000,
): () => Promise<void> {
  let stopped = false;
  const abort = new AbortController();
  let after: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const tick = async () => {
    try {
      do { after = await reconcileIdlePausedUpgrades(controlDb, after, log, 25, abort.signal); }
      while (after && !stopped);
    }
    catch (err) { log.error({ err }, '[idle-pause] upgrade recovery scan failed'); }
    finally {
      if (!stopped) {
        timer = setTimeout(() => { active = tick(); }, intervalMs);
        timer.unref();
      }
    }
  };
  active = tick();
  return async () => {
    stopped = true;
    abort.abort();
    if (timer) clearTimeout(timer);
    await active;
  };
}
