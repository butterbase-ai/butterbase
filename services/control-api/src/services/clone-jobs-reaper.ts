// services/control-api/src/services/clone-jobs-reaper.ts
//
// Safety net for template_clone_jobs stuck in a mid-stage status.
//
// The neon-task queue already handles retries and permanent-fail for the
// common case (worker throws → backoff → eventual 'failed' after
// max_attempts). But some historical failure modes bypass that path
// entirely: a bug that returned success from executeClone without touching
// the job status, a control-api instance killed by SIGKILL mid-transaction
// before the queue could react, or a lost neon_tasks row. This reaper is
// the backstop.
//
// Every REAPER_INTERVAL_MS it looks for template_clone_jobs whose status is
// neither terminal nor pre-processing (i.e. one of the mid-stage statuses)
// and whose updated_at is older than STALE_THRESHOLD_MINUTES. For each
// candidate it checks the dest region's neon_tasks table for a live task
// row (status pending or processing) — if one exists, the queue is still
// working on it and we leave it alone. Otherwise we flip the job to
// 'failed' with a diagnostic error_message, insert the audit event, and
// notify the dest owner + ops.

import type pg from 'pg';
import { getRuntimeDbPool } from './runtime-db.js';
import { config } from '../config.js';
import { setCloneJobStatus, type CloneJobStatus } from './clone-jobs.js';
import { insertCloneAuditLog } from './audit/audit-events-service.js';
import { notifyCloneFailed, notifyCloneReaperDigest } from './failure-notifications.service.js';

const STALE_THRESHOLD_MINUTES = 15;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 100;
const REAP_ERROR_MESSAGE = 'Clone worker abandoned mid-stage; reaped by clone-jobs-reaper.';

export interface ReaperLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

interface Candidate {
  id: string;
  source_app_id: string;
  dest_app_id: string | null;
  dest_region: string;
  status: CloneJobStatus;
  requested_by_user_id: string;
  updated_at: Date;
  ageMinutes: number;
}

async function fetchCandidates(controlDb: Pick<pg.Pool, 'query'>): Promise<Candidate[]> {
  const res = await controlDb.query<{
    id: string;
    source_app_id: string;
    dest_app_id: string | null;
    dest_region: string;
    status: CloneJobStatus;
    requested_by_user_id: string;
    updated_at: Date;
    age_minutes: string;
  }>(
    `SELECT id, source_app_id, dest_app_id, dest_region, status, requested_by_user_id, updated_at,
            EXTRACT(EPOCH FROM (now() - updated_at)) / 60 AS age_minutes
       FROM template_clone_jobs
      WHERE status NOT IN ('completed', 'failed', 'pending', 'processing')
        AND updated_at < now() - interval '${STALE_THRESHOLD_MINUTES} minutes'
      ORDER BY updated_at ASC
      LIMIT $1`,
    [BATCH_LIMIT],
  );
  return res.rows.map((r) => ({
    id: r.id,
    source_app_id: r.source_app_id,
    dest_app_id: r.dest_app_id,
    dest_region: r.dest_region,
    status: r.status,
    requested_by_user_id: r.requested_by_user_id,
    updated_at: r.updated_at,
    ageMinutes: Math.round(Number(r.age_minutes)),
  }));
}

/**
 * Returns true if the region's neon_tasks table has a pending/processing
 * clone task for this job. When true, we leave the job alone — the queue
 * will finish or terminally fail it via the normal path.
 */
async function hasLiveNeonTask(
  region: string,
  jobId: string,
  logger: ReaperLogger,
): Promise<boolean> {
  try {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
    const res = await runtimePool.query<{ id: number }>(
      `SELECT id FROM neon_tasks
        WHERE task_type = 'clone'
          AND status IN ('pending', 'processing')
          AND task_meta->>'job_id' = $1
        LIMIT 1`,
      [jobId],
    );
    return res.rows.length > 0;
  } catch (err) {
    // On a lookup failure, assume live to be safe — we'd rather leave a
    // job un-reaped for another tick than falsely flip a running job to failed.
    logger.warn({ err, region, jobId }, '[clone-jobs-reaper] neon_tasks lookup failed; assuming live');
    return true;
  }
}

export async function runOnce(
  controlDb: pg.Pool,
  logger: ReaperLogger,
): Promise<{ reapedJobIds: string[]; details: Array<{ jobId: string; destAppId: string | null; stalledStage: string; ageMinutes: number }> }> {
  const candidates = await fetchCandidates(controlDb);
  const reapedJobIds: string[] = [];
  const details: Array<{ jobId: string; destAppId: string | null; stalledStage: string; ageMinutes: number }> = [];

  for (const c of candidates) {
    if (await hasLiveNeonTask(c.dest_region, c.id, logger)) {
      logger.info({ jobId: c.id, status: c.status, ageMinutes: c.ageMinutes }, '[clone-jobs-reaper] skipping; live neon_task exists');
      continue;
    }

    const errorMessage = `${REAP_ERROR_MESSAGE} (stage: ${c.status}, age: ${c.ageMinutes}m)`;
    try {
      await setCloneJobStatus(controlDb, c.id, {
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date(),
      });
    } catch (err) {
      logger.error({ err, jobId: c.id }, '[clone-jobs-reaper] failed to mark job failed; skipping notifications');
      continue;
    }

    logger.error(
      { jobId: c.id, destAppId: c.dest_app_id, stalledStage: c.status, ageMinutes: c.ageMinutes },
      '[clone] reaper: stalled job',
    );

    // Audit event on source app so template owners see the failure signal too.
    insertCloneAuditLog(controlDb, {
      appId: c.source_app_id,
      userId: c.requested_by_user_id,
      eventType: 'template_clone_failed',
      metadata: {
        job_id: c.id,
        dest_app_id: c.dest_app_id,
        dest_region: c.dest_region,
        error: errorMessage,
        reaped: true,
        stalled_stage: c.status,
      },
    }).catch((auditErr) => logger.error({ auditErr, jobId: c.id }, '[clone-jobs-reaper] audit insert failed'));

    // Notify the dest owner + ops. Only when a dest_app_id exists — otherwise
    // there's no owner to look up. The ops-alert path inside notifyCloneFailed
    // still fires via the separate dedup key.
    if (c.dest_app_id) {
      const destRuntimePool = getRuntimeDbPool(config.runtimeDb, c.dest_region);
      notifyCloneFailed(
        controlDb,
        destRuntimePool,
        {
          appId: c.dest_app_id,
          jobId: c.id,
          sourceAppId: c.source_app_id,
          errorMessage,
          stalledStage: c.status,
        },
        logger,
      ).catch((notifyErr) => logger.error({ notifyErr, jobId: c.id }, '[clone-jobs-reaper] notifyCloneFailed failed'));
    }

    reapedJobIds.push(c.id);
    details.push({
      jobId: c.id,
      destAppId: c.dest_app_id,
      stalledStage: c.status,
      ageMinutes: c.ageMinutes,
    });
  }

  if (reapedJobIds.length > 0) {
    logger.warn(
      { reapedCount: reapedJobIds.length, jobIds: reapedJobIds },
      '[clone-jobs-reaper] reaped stuck jobs',
    );
    notifyCloneReaperDigest({ reapedJobIds, details }, logger).catch((err) =>
      logger.error({ err }, '[clone-jobs-reaper] digest send failed'),
    );
  }

  return { reapedJobIds, details };
}

export function startCloneJobsReaper(
  controlDb: pg.Pool,
  logger: ReaperLogger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { stop(): Promise<void> } {
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await runOnce(controlDb, logger);
    } catch (err) {
      logger.error({ err }, '[clone-jobs-reaper] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs }, '[clone-jobs-reaper] started');
  activeRun = tick();

  return {
    async stop() {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[clone-jobs-reaper] stopped');
    },
  };
}
