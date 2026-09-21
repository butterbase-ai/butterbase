// services/control-api/src/services/low-balance-notifier.ts
//
// Periodic ops sweep: finds organizations whose credit balance has fallen
// below OPS_LOW_BALANCE_THRESHOLD_USD (default $1) and tells the team, by
// email to OPS_ALERT_EMAIL and by message to the ops Google Chat space.
//
// WHY A SWEEP AND NOT A SETTLE HOOK. The obvious place for this is beside
// maybeSendCreditsEmail on the AI router's post-settle path, and that is the
// wrong place. Two reasons:
//   1. The router is not the only thing that spends credits —
//      deductCreditsBalance (usage-metering) debits outside the lease
//      subsystem entirely, and a hook on the router would never see it.
//   2. An edge-triggered alert reports a crossing; operators need the
//      standing list of who is currently stuck. A sweep answers "who is down
//      right now", survives a restart, and cannot miss a crossing that
//      happened while the process was rolling.
//
// PAID PLANS ONLY BY DEFAULT. Roughly 379 playground orgs sit under $1 at any
// given moment — that is the free tier working as designed, not an incident.
// Paging on it would bury the handful of paying customers who need a human.
// Set OPS_LOW_BALANCE_PLANS to widen the net.
//
// Nothing here may throw. It runs on a timer with no caller to catch it, and
// an alerting path that crashes the process is worse than no alerting.

import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { getRedisClient } from './redis.js';
import { sendBillingEmail } from './auth/email-service.js';
import { sendOpsChatMessage } from './ops-chat.js';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** One alert per org per day. The sweep runs every 15 minutes and an org can
 *  sit below the threshold for weeks, so without this the team would get the
 *  same name 96 times a day. A 24h TTL also means the key re-arms on its own:
 *  an org that is still down tomorrow is worth saying again, and one that
 *  recovered simply never matches the query. No explicit clear-on-recovery
 *  pass is needed, which keeps the sweep a single read. */
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_THRESHOLD_USD = 1.0;
const DEFAULT_PLANS = ['launch', 'certified', 'enterprise'];

export interface LowBalanceOrg {
  id: string;
  name: string;
  planId: string;
  balanceUsd: number;
  floorUsd: number;
  /** Balance is already under the floor, so the AI router is refusing this
   *  org's calls right now. Distinct urgency from "approaching empty". */
  cutOff: boolean;
}

interface Logger {
  info: (payload: Record<string, unknown>, message: string) => void;
  warn: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
}

export interface ScanDeps {
  pool: Pool;
  redis: Pick<Redis, 'set'>;
  sendEmail: (to: string, template: string, data: Record<string, string>) => Promise<void>;
  sendChat: (text: string) => Promise<boolean>;
  log: Logger;
}

function threshold(): number {
  const raw = parseFloat(process.env.OPS_LOW_BALANCE_THRESHOLD_USD ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_USD;
}

function plans(): string[] {
  const raw = (process.env.OPS_LOW_BALANCE_PLANS ?? '').trim();
  if (!raw) return DEFAULT_PLANS;
  const parsed = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_PLANS;
}

interface Row {
  id: string;
  name: string;
  plan_id: string;
  balance: string;
  eff_floor: string;
}

/**
 * Run one sweep. Returns the orgs actually alerted on this tick — i.e. those
 * below the threshold that were not already reported inside the dedup window.
 */
export async function scanLowBalanceOnce(deps: ScanDeps): Promise<{ alerted: LowBalanceOrg[] }> {
  const { pool, redis, sendEmail, sendChat, log } = deps;
  const limit = threshold();

  let rows: Row[];
  try {
    const res = await pool.query<Row>(
      `SELECT o.id,
              o.name,
              o.plan_id,
              (o.monthly_allowance_usd + o.credits_usd)::text        AS balance,
              COALESCE(o.credit_floor_usd, p.credit_floor_usd, 0)::text AS eff_floor
         FROM organizations o
         LEFT JOIN plans p ON p.id = o.plan_id
        WHERE (o.monthly_allowance_usd + o.credits_usd) < $1
          AND o.plan_id = ANY($2)
          AND o.account_status = 'active'
        ORDER BY (o.monthly_allowance_usd + o.credits_usd) ASC`,
      [limit, plans()],
    );
    rows = res.rows;
  } catch (err) {
    log.error({ err }, 'low-balance-notifier: scan query failed');
    return { alerted: [] };
  }

  if (rows.length === 0) return { alerted: [] };

  const alerted: LowBalanceOrg[] = [];
  for (const r of rows) {
    const balanceUsd = parseFloat(r.balance);
    const floorUsd = parseFloat(r.eff_floor);
    let claimed: string | null = null;
    try {
      claimed = await redis.set(`ops_low_balance:${r.id}`, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    } catch (err) {
      // Redis down: alert rather than stay silent. A duplicate ping is a far
      // cheaper failure than a customer sitting cut off with nobody told.
      log.warn({ err, orgId: r.id }, 'low-balance-notifier: dedup check failed, alerting anyway');
      claimed = 'OK';
    }
    if (!claimed) continue;
    alerted.push({
      id: r.id,
      name: r.name,
      planId: r.plan_id,
      balanceUsd,
      floorUsd,
      cutOff: balanceUsd < floorUsd,
    });
  }

  if (alerted.length === 0) return { alerted: [] };

  const cutOffCount = alerted.filter((o) => o.cutOff).length;
  log.info({ count: alerted.length, cutOffCount }, 'low-balance-notifier: alerting');

  // Email and chat are independent on purpose: a broken SES identity or a
  // rotated webhook must not take the other channel down with it.
  await Promise.allSettled([
    sendEmail(process.env.OPS_ALERT_EMAIL || 'ken@butterbase.ai', 'org_balance_low_ops', {
      threshold_usd: limit.toFixed(2),
      org_count: String(alerted.length),
      cut_off_count: String(cutOffCount),
      orgs_json: JSON.stringify(alerted),
    }).catch((err) => {
      log.warn({ err }, 'low-balance-notifier: ops email failed');
    }),
    sendChat(formatChatMessage(alerted, limit, cutOffCount)).catch((err) => {
      log.warn({ err }, 'low-balance-notifier: ops chat failed');
    }),
  ]);

  return { alerted };
}

/** Plain text, because Google Chat incoming webhooks render `text` as-is and
 *  the alert has to be readable on a phone at 2am. Cut-off orgs lead. */
export function formatChatMessage(orgs: LowBalanceOrg[], limit: number, cutOffCount: number): string {
  const header = cutOffCount > 0
    ? `⛔ ${cutOffCount} org(s) CUT OFF, ${orgs.length} under $${limit.toFixed(2)}`
    : `⚠️ ${orgs.length} org(s) under $${limit.toFixed(2)}`;
  const lines = orgs.map((o) => {
    const mark = o.cutOff ? '⛔' : '·';
    return `${mark} ${o.name} (${o.planId}) — $${o.balanceUsd.toFixed(4)}`;
  });
  return [header, ...lines].join('\n');
}

/**
 * Start the sweep loop. Returns the interval handle so the caller can clear
 * it on shutdown, matching startFailureNotifier.
 */
export function startLowBalanceNotifier(pool: Pool, log: Logger): NodeJS.Timeout {
  log.info({ intervalMs: SCAN_INTERVAL_MS, thresholdUsd: threshold(), plans: plans() }, 'low-balance-notifier started');
  return setInterval(() => {
    scanLowBalanceOnce({
      pool,
      redis: getRedisClient(),
      sendEmail: (to, template, data) => sendBillingEmail(to, template as never, data),
      sendChat: (text) => sendOpsChatMessage(text),
      log,
    }).catch((err) => log.error({ err }, 'low-balance-notifier: scan threw'));
  }, SCAN_INTERVAL_MS);
}
