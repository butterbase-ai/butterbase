import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { notifyPauseStateChanged, setPausedState } from './app-pause.js';
import { idlePauseConfigFromEnv, type IdlePauseConfig } from './idle-pause-config.js';
import { sendIdlePauseEmail, sendIdlePauseBreakerEmail, type IdlePauseApp } from './idle-pause-emails.js';

const LOCK_KEY = 'lock:idle-pause-reaper';
const LOCK_SECONDS = 3600;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const RENEW = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export interface IdleReaperDeps {
  signal?: AbortSignal;
  controlDb: Pool;
  runtimeDb(region: string): Pool;
  redis: {
    set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<string | null>;
    eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
  };
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}
export interface IdlePauseSummary { candidates: number; visited: number; warned: number; notified: number; paused: number; breaker: boolean; locked: boolean }
interface Ref { app_id: string; region: string; organization_id: string; plan_id: string }
type Stage = 'warn' | 'notify' | 'pause';
interface Candidate extends IdlePauseApp { stage: Stage; last_active_at: Date }

// Repeated inside every UPDATE. Never trust a previously selected runtime row.
const BASE = `id = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
  AND paused = false AND provisioning_status = 'ready'
  AND NOT EXISTS (SELECT 1 FROM app_environments e WHERE e.staging_app_id = apps.id)
  AND last_active_at < now() - ($3::int - $4::int) * interval '1 day'`;
const STAGES: Record<Stage, string> = {
  warn: 'idle_warned_at IS NULL',
  notify: `last_active_at < now() - $3::int * interval '1 day'
    AND idle_warned_at < now() - $4::int * interval '1 day' AND idle_pause_notified_at IS NULL`,
  pause: `last_active_at < now() - $3::int * interval '1 day'
    AND idle_warned_at < now() - $4::int * interval '1 day'
    AND idle_pause_notified_at < now() - $5::int * interval '1 day'`,
};

async function freeApps(controlDb: Pool, cfg: IdlePauseConfig): Promise<Ref[]> {
  return (await controlDb.query<Ref>(
    `SELECT oai.app_id, oai.region, oai.organization_id, o.plan_id FROM org_app_index oai
       JOIN organizations o ON o.id = oai.organization_id
      WHERE o.plan_id = ANY($1::text[]) AND o.account_status <> 'suspended'`, [cfg.plans],
  )).rows;
}

async function visitedApps(controlDb: Pool, ids: string[], cfg: IdlePauseConfig): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await controlDb.query<{ app_id: string }>(
    `SELECT app_id FROM frontend_visit_daily
      WHERE app_id = ANY($1::text[]) AND day >= CURRENT_DATE - $2::int
      GROUP BY app_id HAVING SUM(unique_visitor_count) >= $3::int`, [ids, cfg.days, cfg.minVisitors],
  );
  return new Set(rows.rows.map((r) => r.app_id));
}

/** One guarded sweep. Production callers log failures and retry at the next tick. */
export async function runIdlePauseOnce(deps: IdleReaperDeps, cfg: IdlePauseConfig): Promise<IdlePauseSummary> {
  const { controlDb, redis, log } = deps;
  const summary: IdlePauseSummary = { candidates: 0, visited: 0, warned: 0, notified: 0, paused: 0, breaker: false, locked: false };
  const token = randomUUID();
  if (await redis.set(LOCK_KEY, token, 'EX', LOCK_SECONDS, 'NX') !== 'OK') return { ...summary, locked: true };
  const requireLease = async () => {
    if (deps.signal?.aborted) throw new Error('Idle pause sweep stopped');
    if (Number(await redis.eval(RENEW, 1, LOCK_KEY, token, LOCK_SECONDS)) !== 1) throw new Error('Idle pause lease lost');
  };
  try {
    const refs = await freeApps(controlDb, cfg);
    const visited = await visitedApps(controlDb, refs.map((r) => r.app_id), cfg);
    summary.visited = visited.size;
    const groups = new Map<string, Ref[]>();
    for (const ref of refs) {
      if (visited.has(ref.app_id)) continue;
      if (!groups.has(ref.region)) groups.set(ref.region, []);
      groups.get(ref.region)!.push(ref);
    }
    const selected = new Map<string, Candidate[]>();
    let scanFailed = false;
    for (const [region, apps] of groups) {
      try {
        const r = await deps.runtimeDb(region).query<Candidate>(
          `SELECT id, name, organization_id, last_active_at,
            CASE WHEN ${STAGES.pause} THEN 'pause' WHEN ${STAGES.notify} THEN 'notify'
                 WHEN ${STAGES.warn} THEN 'warn' END AS stage
           FROM apps WHERE ${BASE}`,
          [apps.map((a) => a.app_id), [...new Set(apps.map((a) => a.organization_id))], cfg.days, cfg.warnDays, cfg.graceDays],
        );
        selected.set(region, r.rows.filter((r) => r.stage));
      } catch (err) {
        scanFailed = true;
        log.error({ err, region }, '[idle-pause-reaper] region scan failed');
      }
    }
    // Without every region, the global breaker could undercount. Continue scans
    // for diagnostics, but do not change anything on an incomplete snapshot.
    if (scanFailed) return summary;
    const candidates = [...selected.values()].flat();
    summary.candidates = candidates.length;
    const impact = candidates.filter((c) => c.stage !== 'warn').length;
    summary.breaker = impact > cfg.maxPerTick || impact > cfg.maxFraction * refs.length;
    if (cfg.dryRun) {
      const planByApp = new Map(refs.map((r) => [r.app_id, r.plan_id]));
      log.info({ ...summary, dryRun: true, apps: [...selected].flatMap(([region, apps]) => apps.map((a) => ({ ...a, region, plan: planByApp.get(a.id) }))) }, '[idle-pause-reaper] dry run');
      return summary;
    }
    if (summary.breaker) {
      log.error({ impact, freeApps: refs.length }, '[idle-pause-reaper] circuit breaker triggered');
      await sendIdlePauseBreakerEmail(impact, refs.length, log);
    }

    // Frontend-only apps do not pass through the request hook. Qualifying
    // human visits cancel pending warnings/grace too, so old notices cannot
    // be reused to pause the app as soon as those visits age out of the window.
    if (visited.size) {
      const current = await freeApps(controlDb, cfg);
      const visits = await visitedApps(controlDb, current.map((r) => r.app_id), cfg);
      const byRegion = new Map<string, Ref[]>();
      for (const ref of current) {
        if (!visits.has(ref.app_id)) continue;
        if (!byRegion.has(ref.region)) byRegion.set(ref.region, []);
        byRegion.get(ref.region)!.push(ref);
      }
      for (const [region, refs] of byRegion) {
        await requireLease();
        await deps.runtimeDb(region).query(
          `UPDATE apps SET idle_warned_at = NULL, idle_pause_notified_at = NULL
            WHERE id = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
              AND paused = false AND (idle_warned_at IS NOT NULL OR idle_pause_notified_at IS NOT NULL)`,
          [refs.map((r) => r.app_id), [...new Set(refs.map((r) => r.organization_id))]],
        );
      }
    }

    for (const [region, apps] of selected) {
      const runtime = deps.runtimeDb(region);
      for (const stage of ['warn', 'notify', 'pause'] as const) {
        if (summary.breaker && stage !== 'warn') continue;
        const targets = apps.filter((a) => a.stage === stage);
        if (!targets.length) continue;
        // Control-plane errors abort the tick. Fresh traffic is also rechecked
        // in the runtime UPDATE so it can win between this read and the write.
        const targetOrgs = new Map(targets.map((t) => [t.id, t.organization_id]));
        const fresh = (await freeApps(controlDb, cfg)).filter((r) => r.region === region && targetOrgs.get(r.app_id) === r.organization_id);
        const visits = await visitedApps(controlDb, fresh.map((r) => r.app_id), cfg);
        const eligible = fresh.filter((r) => !visits.has(r.app_id));
        if (!eligible.length) continue;
        await requireLease();
        const assignment = stage === 'warn' ? 'idle_warned_at = now()'
          : stage === 'notify' ? 'idle_pause_notified_at = now()'
          : `paused = true, paused_at = now(), paused_by = 'idle_reaper',
             paused_reason = 'Paused after ${cfg.days} days without activity.', updated_at = now()`;
        // Parameter arity matches each predicate (warn/notify do not use $5).
        const params: unknown[] = [eligible.map((r) => r.app_id), [...new Set(eligible.map((r) => r.organization_id))], cfg.days, cfg.warnDays];
        if (stage === 'pause') params.push(cfg.graceDays);
        let changed: Candidate[];
        try {
          changed = (await runtime.query<Candidate>(
            `UPDATE apps SET ${assignment} WHERE ${BASE} AND ${STAGES[stage]} RETURNING id,name,organization_id,last_active_at`, params,
          )).rows;
        } catch (err) {
          log.error({ err, region, stage }, '[idle-pause-reaper] region update failed');
          continue;
        }
        // Org plan and visits live in another DB. An upgrade could have already
        // run its resume hook before our UPDATE. Recheck after the write and
        // compensate, rather than leaving a newly paid app permanently paused.
        let stillEligible: Ref[];
        try {
          const current = await freeApps(controlDb, cfg);
          const recent = await visitedApps(controlDb, changed.map((r) => r.id), cfg);
          stillEligible = current.filter((r) => r.region === region && !recent.has(r.app_id));
        } catch (err) {
          await undo(runtime, changed, stage, log);
          throw err;
        }
        const eligibleOrgs = new Map(stillEligible.map((r) => [r.app_id, r.organization_id]));
        const valid = changed.filter((a) => eligibleOrgs.get(a.id) === a.organization_id);
        await undo(runtime, changed.filter((a) => eligibleOrgs.get(a.id) !== a.organization_id), stage, log);
        for (const app of valid) {
          // Complete effects for committed rows even if the lease expires now.
          // A subsequent worker cannot reselect these already-advanced rows.
          if (stage === 'pause') {
            await notifyPauseStateChanged({ appId: app.id, paused: true, by: 'idle_reaper' }, log);
            summary.paused++;
          } else {
            await sendIdlePauseEmail(controlDb, app, stage === 'warn' ? 'project_idle_warning' : 'project_paused_idle', cfg.warnDays, log);
            if (stage === 'warn') summary.warned++; else summary.notified++;
          }
        }
      }
    }
    return summary;
  } finally {
    await redis.eval(RELEASE, 1, LOCK_KEY, token).catch((err) => log.warn({ err }, '[idle-pause-reaper] lease release failed'));
    log.info(summary, '[idle-pause-reaper] tick complete');
  }
}

async function undo(runtime: Pool, apps: Candidate[], stage: Stage, log: IdleReaperDeps['log']): Promise<void> {
  for (const app of apps) {
    if (stage === 'pause') {
      await setPausedState(runtime, app.id, { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, log);
    } else {
      await runtime.query(`UPDATE apps SET idle_warned_at = NULL, idle_pause_notified_at = NULL WHERE id = $1 AND paused = false`, [app.id]);
    }
  }
}

export function startIdlePauseReaper(deps: IdleReaperDeps, intervalMs = INTERVAL_MS): () => Promise<void> {
  const cfg = idlePauseConfigFromEnv();
  if (!cfg || process.env.SKIP_IDLE_PAUSE_REAPER) return async () => {};
  const abort = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRun: Promise<void>;
  const tick = async () => {
    if (stopped) return;
    try { await runIdlePauseOnce({ ...deps, signal: abort.signal }, cfg); }
    catch (err) { if (!stopped) deps.log.error({ err }, '[idle-pause-reaper] tick failed'); }
    finally { if (!stopped) { timer = setTimeout(() => { activeRun = tick(); }, intervalMs); timer.unref(); } }
  };
  activeRun = tick();
  return async () => {
    stopped = true;
    abort.abort();
    if (timer) clearTimeout(timer);
    // Finish compensation and effects for the already committed batch. Abort
    // is checked before each subsequent UPDATE, so draining cannot start more.
    await activeRun;
  };
}
