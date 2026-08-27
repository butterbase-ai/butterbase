// Weekly digest scanner.
//
// Strategy: a single hourly tick checks "is this the digest hour"
// (Sunday 18:00 UTC). When it is, scan all opted-in users, build a per-user
// summary of failing functions in the last 7 days across every region, and
// send one email per user via the weekly_digest template.
//
// Idempotency: Redis key `digest_sent:{userId}:{isoWeek}` is set with
// SET NX before the email; if the scanner runs twice in the same hour we
// don't double-send. Set with 14-day TTL so the key survives missed weeks.
//
// Opt-in only. Reads notification_preferences.digest_enabled — default
// false (set by migration 070). Users opt in via the (Phase 3.5) settings
// page. No suppression of per-failure emails: digest is additive.

import type { Pool } from 'pg';
import { getRedisClient } from './redis.js';
import { config } from './../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { sendBillingEmail } from './auth/email-service.js';
import type { DigestItem, DigestDeployItem } from './auth/email-service.js';
import { resolveOrganizationId } from './org-resolver.js';
import { getRuntimeDbForApp } from './region-resolver.js';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DIGEST_DOW = 0;   // 0 = Sunday
const DIGEST_HOUR = 18; // 18:00 UTC
const DEDUP_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_ITEMS_PER_DIGEST = 20;

type Log = {
  info: (p: any, m: string) => void;
  warn: (p: any, m: string) => void;
  error: (p: any, m: string) => void;
};

interface OptedInUser {
  user_id: string;
  email: string;
}

interface RegionalGroup {
  app_id: string;
  app_name: string;
  function_name: string;
  failure_count: number;
  last_error: string;
}

/** ISO 8601 week string ("2026-W20") — Redis dedup key per user, per week. */
export function isoWeekKey(d: Date = new Date()): string {
  // Borrowed from the Date Object spec recipe — copy d, set to Thursday of
  // the same week, compute year + week.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNo = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function isDigestHour(d: Date = new Date()): boolean {
  return d.getUTCDay() === DIGEST_DOW && d.getUTCHours() === DIGEST_HOUR;
}

async function fetchOptedInUsers(controlPool: Pool): Promise<OptedInUser[]> {
  const r = await controlPool.query<OptedInUser>(
    `SELECT np.user_id, pu.email
       FROM notification_preferences np
       JOIN platform_users pu ON pu.id = np.user_id
      WHERE np.digest_enabled = true
        AND pu.email IS NOT NULL`,
  );
  return r.rows;
}

/**
 * For one organization, collect failing functions across every runtime region.
 * Returns top MAX_ITEMS_PER_DIGEST by failure count.
 */
async function collectDigestItems(organizationId: string): Promise<DigestItem[]> {
  const items: DigestItem[] = [];
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    try {
      const r = await pool.query<RegionalGroup>(
        `SELECT fi.app_id,
                a.name AS app_name,
                af.name AS function_name,
                COUNT(*)::int AS failure_count,
                (SELECT error_message FROM function_invocations
                  WHERE function_id = fi.function_id
                    AND error_message IS NOT NULL
                    AND started_at >= now() - interval '7 days'
                  ORDER BY started_at DESC LIMIT 1) AS last_error
           FROM function_invocations fi
           JOIN apps a ON a.id = fi.app_id
           JOIN app_functions af ON af.id = fi.function_id
          WHERE fi.error_message IS NOT NULL
            AND fi.started_at >= now() - interval '7 days'
            AND a.organization_id = $1
          GROUP BY fi.app_id, a.name, fi.function_id, af.name
          ORDER BY COUNT(*) DESC`,
        [organizationId],
      );
      for (const row of r.rows) {
        items.push({
          appId: row.app_id,
          appName: row.app_name,
          functionName: row.function_name,
          failureCount: row.failure_count,
          lastError: row.last_error ?? '',
        });
      }
    } catch (err) {
      // One region failing shouldn't take the whole digest down.
      console.warn(`[digest-notifier] region scan failed for ${region}: ${err}`);
    }
  }
  items.sort((a, b) => b.failureCount - a.failureCount);
  return items.slice(0, MAX_ITEMS_PER_DIGEST);
}

/**
 * Failed-deploy aggregation across both deploy tables. Fans out across
 * runtime regions (apps, app_deployments, and app_edge_ssr_deployments all
 * moved to runtime). Per-region errors are caught and logged so one bad
 * region doesn't take the whole digest down. Returns top
 * MAX_ITEMS_PER_DIGEST by failure count.
 */
async function collectDeployFailures(
  _controlPool: Pool,
  organizationId: string,
): Promise<DigestDeployItem[]> {
  const regions = Object.keys(config.runtimeDb.urlsByRegion);
  const items: DigestDeployItem[] = [];
  for (const region of regions) {
    try {
      const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
      const r = await runtimePool.query<{
        app_id: string;
        app_name: string;
        kind: 'frontend' | 'edge-ssr';
        failure_count: number;
        last_error: string | null;
      }>(
        `WITH frontend AS (
           SELECT d.app_id, a.name AS app_name, 'frontend'::text AS kind,
                  COUNT(*)::int AS failure_count,
                  (SELECT error_message FROM app_deployments
                    WHERE app_id = d.app_id AND status = 'failed'
                      AND created_at >= now() - interval '7 days'
                      AND error_message IS NOT NULL
                    ORDER BY created_at DESC LIMIT 1) AS last_error
             FROM app_deployments d
             JOIN apps a ON a.id = d.app_id
            WHERE d.status = 'failed'
              AND d.created_at >= now() - interval '7 days'
              AND a.organization_id = $1
            GROUP BY d.app_id, a.name
         ),
         edge AS (
           SELECT d.app_id, a.name AS app_name, 'edge-ssr'::text AS kind,
                  COUNT(*)::int AS failure_count,
                  (SELECT error_message FROM app_edge_ssr_deployments
                    WHERE app_id = d.app_id AND status = 'ERROR'
                      AND created_at >= now() - interval '7 days'
                      AND error_message IS NOT NULL
                    ORDER BY created_at DESC LIMIT 1) AS last_error
             FROM app_edge_ssr_deployments d
             JOIN apps a ON a.id = d.app_id
            WHERE d.status = 'ERROR'
              AND d.created_at >= now() - interval '7 days'
              AND a.organization_id = $1
            GROUP BY d.app_id, a.name
         )
         SELECT * FROM frontend UNION ALL SELECT * FROM edge
         ORDER BY failure_count DESC`,
        [organizationId],
      );
      for (const row of r.rows) {
        items.push({
          appId: row.app_id,
          appName: row.app_name,
          kind: row.kind,
          failureCount: row.failure_count,
          lastError: row.last_error ?? '',
        });
      }
    } catch (err) {
      console.warn(`[digest-notifier] deploy-failures region scan failed for ${region}: ${err}`);
    }
  }
  items.sort((a, b) => b.failureCount - a.failureCount);
  return items.slice(0, MAX_ITEMS_PER_DIGEST);
}

export interface TemplateUpdateItem {
  dest_app_id: string;
  source_app_id: string;
  behind_by: number;
  latest_label: string | null;
}

/**
 * Forks in this org that are behind their template AND have not modified their
 * repo.
 *
 * Modified forks are deliberately excluded. Telling someone they are "2 releases
 * behind" when there is no Update button creates an obligation they cannot
 * discharge, and for a heavily customized app re-cloning is absurd. That is
 * notification noise, and noise trains people to unsubscribe from a digest that
 * also carries failing-function and failed-deploy alerts they genuinely need.
 * The badge and changelog remain available to them on the page — pull, not push.
 *
 * "Unmodified" uses the repo signal only: a single column compare, safe to run
 * across every fork. A per-fork backend introspect would make this unbounded.
 */
export async function collectTemplateUpdates(
  controlPool: Pool,
  organizationId: string,
): Promise<TemplateUpdateItem[]> {
  const res = await controlPool.query<{
    dest_app_id: string; source_app_id: string;
    behind_by: string; latest_label: string | null;
  }>(
    `WITH forks AS (
       SELECT l.dest_app_id, l.source_app_id, l.cloned_at, l.base_snapshot_id,
              COALESCE(br.release_number, 0) AS base_number
         FROM app_lineage l
         LEFT JOIN template_releases br ON br.id = l.base_release_id
         JOIN org_app_index oai ON oai.app_id = l.dest_app_id
        WHERE oai.organization_id = $1
          AND l.severed_at IS NULL
          AND l.base_snapshot_id IS NOT NULL
     )
     SELECT f.dest_app_id, f.source_app_id,
            count(r.id)::text AS behind_by,
            (array_agg(r.label ORDER BY r.release_number DESC))[1] AS latest_label
       FROM forks f
       JOIN template_releases r
         ON r.source_app_id = f.source_app_id
        AND (CASE WHEN f.base_number > 0
                  THEN r.release_number > f.base_number
                  ELSE r.published_at > f.cloned_at END)
      GROUP BY f.dest_app_id, f.source_app_id
      HAVING count(r.id) > 0
      ORDER BY count(r.id) DESC
      LIMIT ${MAX_ITEMS_PER_DIGEST}`,
    [organizationId],
  );

  // apps.repo_latest_snapshot lives in the fork's home region, so this is a
  // per-region lookup rather than a join. Bounded by MAX_ITEMS_PER_DIGEST.
  const unmodified: TemplateUpdateItem[] = [];
  for (const r of res.rows) {
    const item = {
      dest_app_id: r.dest_app_id, source_app_id: r.source_app_id,
      behind_by: Number(r.behind_by), latest_label: r.latest_label,
    };
    try {
      const pool = await getRuntimeDbForApp(controlPool, r.dest_app_id);
      const head = await pool.query<{ repo_latest_snapshot: string | null }>(
        `SELECT repo_latest_snapshot FROM apps WHERE id = $1`, [r.dest_app_id],
      );
      const base = await controlPool.query<{ base_snapshot_id: string | null }>(
        `SELECT base_snapshot_id FROM app_lineage WHERE dest_app_id = $1`, [r.dest_app_id],
      );
      if (head.rows[0]?.repo_latest_snapshot === base.rows[0]?.base_snapshot_id) {
        unmodified.push(item);
      }
    } catch {
      // Region unreachable — omit rather than risk emailing a modified fork.
    }
  }
  return unmodified;
}

/**
 * Send one user's digest. Exported for test + manual-trigger use. The
 * scanner loop wraps this with dedup + opt-in checks.
 */
export async function sendDigestForUser(
  controlPool: Pool,
  user: OptedInUser,
  log?: Log,
): Promise<{ sent: boolean; itemCount: number; deployCount: number }> {
  const organizationId = await resolveOrganizationId(controlPool, user.user_id);
  const [items, deploys, templateUpdates] = await Promise.all([
    collectDigestItems(organizationId),
    collectDeployFailures(controlPool, organizationId),
    // Soft-fail: a broken template-updates section must never take down the
    // failing-function / failed-deploy alerts the rest of the digest carries.
    collectTemplateUpdates(controlPool, organizationId).catch(() => [] as TemplateUpdateItem[]),
  ]);
  await sendBillingEmail(user.email, 'weekly_digest', {
    itemsJson: JSON.stringify(items),
    deployItemsJson: JSON.stringify(deploys),
    templateUpdatesJson: JSON.stringify(templateUpdates),
  }, {
    controlPool,
    userId: user.user_id,
  }).catch((err) => {
    log?.warn({ err, userId: user.user_id }, 'digest-notifier: send failed');
  });
  return { sent: true, itemCount: items.length, deployCount: deploys.length };
}

async function scanOnce(controlPool: Pool, log: Log): Promise<void> {
  if (!isDigestHour()) return;
  const week = isoWeekKey();
  const redis = getRedisClient();

  const users = await fetchOptedInUsers(controlPool);
  log.info({ count: users.length, week }, 'digest-notifier: tick');

  for (const user of users) {
    const dedupKey = `digest_sent:${user.user_id}:${week}`;
    let wasSet: 'OK' | null = null;
    try {
      wasSet = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    } catch (err) {
      log.warn({ err, userId: user.user_id }, 'digest-notifier: redis SET NX failed');
      continue;
    }
    if (!wasSet) continue;

    try {
      const { itemCount, deployCount } = await sendDigestForUser(controlPool, user, log);
      log.info({ userId: user.user_id, itemCount, deployCount, week }, 'digest-notifier: sent');
    } catch (err) {
      log.warn({ err, userId: user.user_id }, 'digest-notifier: send threw');
    }
  }
}

/**
 * Start the weekly-digest scan loop. Returns the interval handle so the
 * caller can clear it on shutdown. Ticks hourly; only does work during
 * the digest hour (Sunday 18:00 UTC).
 */
export function startDigestNotifier(controlPool: Pool, log: Log): NodeJS.Timeout {
  log.info({ intervalMs: TICK_INTERVAL_MS, dow: DIGEST_DOW, hour: DIGEST_HOUR }, 'digest-notifier started');
  return setInterval(() => {
    scanOnce(controlPool, log).catch((err) => log.error({ err }, 'digest-notifier: scan threw'));
  }, TICK_INTERVAL_MS);
}
