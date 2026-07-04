// services/control-api/src/services/cf-analytics-puller.ts
//
// Pulls per-script DO metrics from Cloudflare's GraphQL Analytics API every
// 15 minutes. Attributes metrics to apps by parsing the scriptName suffix
// '_do', writes into usage_meters via the existing path. Records-only — no
// enforcement.
import type { Pool } from 'pg';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { resolveOrganizationId } from './org-resolver.js';

const CF_GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const POLL_INTERVAL_MS = 15 * 60 * 1000;

const QUERY = `
  query DoUsage($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000,
          filter: { datetime_gt: $start, datetime_leq: $end }
        ) {
          dimensions { scriptName }
          sum { requests, durationCpu }
        }
      }
    }
  }
`;

interface ScriptRow {
  dimensions: { scriptName: string };
  sum: { requests: number; durationCpu: number };
}

function periodStartUtcMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

async function fetchAndUpsert(controlPool: Pool, scriptRows: ScriptRow[]): Promise<void> {
  const periodStart = periodStartUtcMonth();
  for (const row of scriptRows) {
    const m = row.dimensions.scriptName.match(/^(app_[a-z0-9_]+)_do$/);
    if (!m) continue;
    const appId = m[1];

    // apps + usage_meters live in the app's home region's runtime DB.
    const runtimePool = await getRuntimeDbForApp(controlPool, appId).catch(() => null);
    if (!runtimePool) continue;

    const owner = await runtimePool.query(`SELECT owner_id FROM apps WHERE id = $1`, [appId]);
    const ownerId = owner.rows[0]?.owner_id as string | undefined;
    if (!ownerId) continue;

    const organizationId = await resolveOrganizationId(controlPool, ownerId);

    // Idempotent UPSERT — adds delta to running monthly counter.
    // Note: this insert WILL double-count if the same window is polled twice.
    // For v1 we accept that; v2 should track per-window high-watermarks.
    if (row.sum.requests > 0) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = usage_meters.quantity + EXCLUDED.quantity, updated_at = now()`,
        [ownerId, organizationId, appId, 'do_requests', periodStart, row.sum.requests],
      );
    }
    if (row.sum.durationCpu > 0) {
      await runtimePool.query(
        `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, app_id, meter_type, period_start)
         DO UPDATE SET quantity = usage_meters.quantity + EXCLUDED.quantity, updated_at = now()`,
        [ownerId, organizationId, appId, 'do_cpu_ms', periodStart, row.sum.durationCpu],
      );
    }
  }
}

export async function runAnalyticsPullerOnce(db: Pool): Promise<void> {
  if (!config.cloudflare.enabled) return;

  const end = new Date();
  const start = new Date(end.getTime() - POLL_INTERVAL_MS);

  const res = await fetch(CF_GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.cloudflare.apiToken}`,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: config.cloudflare.accountId,
        start: start.toISOString(),
        end: end.toISOString(),
      },
    }),
  });

  if (!res.ok) {
    console.warn(`[cf-analytics] CF GraphQL returned ${res.status}; skipping this poll`);
    return;
  }

  const body = (await res.json()) as { data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: ScriptRow[] }> } } };
  const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  await fetchAndUpsert(db, rows);
}

export function startAnalyticsPullerCron(db: Pool): NodeJS.Timeout {
  // Fire once at startup, then every 15 min.
  void runAnalyticsPullerOnce(db).catch((err) => console.error('[cf-analytics] initial run failed:', err));
  return setInterval(() => {
    void runAnalyticsPullerOnce(db).catch((err) => console.error('[cf-analytics] poll failed:', err));
  }, POLL_INTERVAL_MS);
}
