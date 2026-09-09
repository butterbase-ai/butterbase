import type pg from 'pg';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';

/**
 * Splits an organization's existing usage between its production apps and its
 * staging environments.
 *
 * WHAT WAS ACTUALLY MISSING (spec §6.7 left billing attribution open, and no
 * task implemented it). The investigation's answer is that the gap is
 * PRESENTATION, not capture — no new metering, no new column, no new write
 * path is needed, and none is added here:
 *
 *   - `usage_meters` already carries `app_id` on every row
 *     (db/runtime-plane/008_usage_meters.sql, `idx_usage_meters_app` on
 *     `(app_id, meter_type, period_start)`), and `flushUsageToDatabase` has
 *     always written it.
 *   - A staging environment IS a separate app with its own id, so every
 *     credit, byte and token it burns is already attributed to it and is
 *     already distinguishable from production's.
 *   - `app_environments.staging_app_id` already says, authoritatively, which
 *     app ids are staging.
 *   - The only reason a customer could not see it is that every read path
 *     aggregates `app_id` away: `GET /dashboard/usage` does
 *     `SUM(quantity) ... GROUP BY meter_type, period_start`, and the org-level
 *     rollups in usage-metering.ts / billing-service.ts all use
 *     `WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)`.
 *
 * So this is a query, and it is the smallest change that makes staging's cost
 * visible. It does not touch `billing-service.ts`, `usage-metering.ts` or any
 * charging path: nothing about what the customer is billed changes, only what
 * they can see. No new billing model is invented — that would be a product
 * decision, and inventing one was explicitly not the job.
 *
 * BOTH TABLES ARE RUNTIME-TIER AND REGIONAL, which is what makes the split a
 * single join rather than a cross-plane merge. `usage_meters` really lives in
 * the runtime planes (the control-plane copy from migration 013 is a legacy
 * leftover — `flushUsageToDatabase` writes to `getRuntimeDbPool(...)`), and
 * `app_environments` is runtime-plane too, with staging pinned to production's
 * region at admission (start-staging.ts). A production app and its staging
 * environment are therefore always in the SAME regional pool, so the LEFT JOIN
 * below can never miss a staging classification because the link row is in
 * another region.
 */

export type EnvironmentKind = 'production' | 'staging';

export interface UsagePoint {
  date: string;
  quantity: number;
}

export interface UsageByEnvironment {
  production: Record<string, UsagePoint[]>;
  staging: Record<string, UsagePoint[]>;
}

export interface StagingUsageBreakdown {
  startDate: string;
  endDate: string;
  usage: UsageByEnvironment;
  /** Totals per meter across the window, so a caller does not have to re-sum. */
  totals: { production: Record<string, number>; staging: Record<string, number> };
  /** The staging app ids that contributed. Ids only — no names, no rows. */
  stagingAppIds: string[];
}

interface Row {
  meter_type: string;
  period: string;
  is_staging: boolean;
  total: string;
}

/**
 * `app_id IS NULL` rows are org-scoped counters with no app to attribute to.
 * They are counted as production rather than dropped: dropping them would make
 * the two halves fail to add up to the org total the customer is billed on,
 * which is a worse untruth than attributing an unattributable row to the
 * default environment. Named here rather than left implicit.
 */
const ORG_SCOPED_COUNTS_AS: EnvironmentKind = 'production';

export async function getUsageByEnvironment(
  controlDb: pg.Pool,
  organizationId: string,
  startDate: string,
  endDate: string,
  opts?: { regions?: string[]; runtimePoolForRegion?: (region: string) => pg.Pool },
): Promise<StagingUsageBreakdown> {
  void controlDb; // reserved: every table read below is runtime-tier.

  const regions = opts?.regions ?? Object.keys(config.runtimeDb.urlsByRegion);
  const poolFor = opts?.runtimePoolForRegion
    ?? ((region: string) => getRuntimeDbPool(config.runtimeDb, region));

  const usage: UsageByEnvironment = { production: {}, staging: {} };
  const totals = {
    production: {} as Record<string, number>,
    staging: {} as Record<string, number>,
  };
  const stagingAppIds = new Set<string>();

  for (const region of regions) {
    const pool = poolFor(region);

    // The classification is the LEFT JOIN, not a name pattern: an app is
    // staging exactly when some app_environments row names it as a
    // staging_app_id. A production app can never match, because a production
    // app appears in that table as prod_app_id and never as staging_app_id.
    const { rows } = await pool.query<Row>(
      `SELECT m.meter_type,
              to_char(m.period_start, 'YYYY-MM-DD') AS period,
              (e.staging_app_id IS NOT NULL) AS is_staging,
              SUM(m.quantity)::bigint AS total
         FROM usage_meters m
         LEFT JOIN app_environments e ON e.staging_app_id = m.app_id
        WHERE m.organization_id = $1
          AND m.period_start >= $2::date
          AND m.period_start <= $3::date
        GROUP BY 1, 2, 3`,
      [organizationId, startDate, endDate],
    );

    for (const row of rows) {
      const kind: EnvironmentKind = row.is_staging ? 'staging' : ORG_SCOPED_COUNTS_AS;
      const quantity = Number.parseInt(row.total, 10) || 0;
      (usage[kind][row.meter_type] ??= []).push({ date: row.period, quantity });
      totals[kind][row.meter_type] = (totals[kind][row.meter_type] ?? 0) + quantity;
    }

    const staging = await pool.query<{ staging_app_id: string }>(
      `SELECT e.staging_app_id
         FROM app_environments e
         JOIN apps a ON a.id = e.staging_app_id
        WHERE a.organization_id = $1`,
      [organizationId],
    );
    for (const r of staging.rows) stagingAppIds.add(r.staging_app_id);
  }

  // A region fan-out can produce two points for the same (meter, date); merge
  // and sort so the series a chart consumes is monotonic.
  for (const kind of ['production', 'staging'] as const) {
    for (const meter of Object.keys(usage[kind])) {
      const merged = new Map<string, number>();
      for (const p of usage[kind][meter]) {
        merged.set(p.date, (merged.get(p.date) ?? 0) + p.quantity);
      }
      usage[kind][meter] = [...merged.entries()]
        .map(([date, quantity]) => ({ date, quantity }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
  }

  return {
    startDate,
    endDate,
    usage,
    totals,
    stagingAppIds: [...stagingAppIds].sort(),
  };
}
