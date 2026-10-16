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
