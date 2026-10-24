// services/control-api/src/services/idle-pause-config.ts
//
// Which plans the idle reaper targets, and whether an app's org is on one.
// The plan comes from the app's org (org_app_index → organizations.plan_id),
// not getLimitsForApp, which reads the owner's personal org and is wrong for
// team orgs.
//
// Spec: docs/superpowers/specs/2026-10-10-idle-free-app-pause-design.md §5.5

import type pg from 'pg';

const DEFAULT_PLANS = ['playground'];

export interface IdlePauseConfig {
  days: number;
  warnDays: number;
  graceDays: number;
  minVisitors: number;
  dryRun: boolean;
  plans: string[];
  maxPerTick: number;
  maxFraction: number;
}

/** Invalid configuration disables the worker rather than tightening policy. */
export function idlePauseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IdlePauseConfig | null {
  const prefix = 'BUTTERBASE_IDLE_PAUSE_';
  const number = (key: string, fallback: number) => {
    const value = env[prefix + key];
    return value == null || value.trim() === '' ? fallback : Number(value);
  };
  const days = number('DAYS', 0);
  const warnDays = number('WARN_DAYS', 7);
  const graceDays = number('GRACE_DAYS', 5);
  const minVisitors = number('MIN_VISITORS', 3);
  const maxPerTick = number('MAX_PER_TICK', 25);
  const maxFraction = number('MAX_FRACTION', 0.2);
  const dryRun = env[prefix + 'DRY_RUN']?.trim() || 'false';
  if (![days, warnDays, graceDays, minVisitors, maxPerTick].every((n) => Number.isSafeInteger(n) && n > 0)
    || days <= warnDays || !(maxFraction > 0 && maxFraction <= 1)
    || !['true', 'false'].includes(dryRun)) return null;
  return { days, warnDays, graceDays, minVisitors, maxPerTick, maxFraction,
    plans: idlePausePlansFromEnv(env[prefix + 'PLANS']), dryRun: dryRun === 'true' };
}

export function idlePausePlansFromEnv(raw: string | undefined = process.env.BUTTERBASE_IDLE_PAUSE_PLANS): string[] {
  const plans = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return plans.length > 0 ? plans : DEFAULT_PLANS;
}

/**
 * True when the app's org is on a plan the idle reaper targets. An app with
 * no org row is never idle-paused by the reaper, so it reports false.
 */
export async function isOnIdlePausePlan(
  controlDb: Pick<pg.Pool, 'query'>,
  appId: string,
  plans: string[] = idlePausePlansFromEnv(),
): Promise<boolean> {
  const r = await controlDb.query<{ plan_id: string | null }>(
    `SELECT o.plan_id
       FROM org_app_index oai
       JOIN organizations o ON o.id = oai.organization_id
      WHERE oai.app_id = $1`,
    [appId],
  );
  const planId = r.rows[0]?.plan_id;
  return planId != null && plans.includes(planId);
}
