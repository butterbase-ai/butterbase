import type { FastifyInstance } from 'fastify';
import { fanOutRuntimeRegions } from '../region-resolver.js';
import { getRedisClient } from '../redis.js';
import { config } from '../../config.js';
import { pollAndSettleVideoJob, buildVideoAdapters } from '../../routes/ai-videos.js';
import type { VideoJobRow } from './video-jobs.js';
import type { RouteContext } from './router.js';
import { resolveOrgFromApp } from '../app-org-resolver.js';

const SWEEP_BATCH_SIZE = 25;
// Skip rows older than this — settle deferred but bounded; the lease will
// auto-refund at its own TTL if we never see the row in time.
const SWEEP_LOOKBACK_INTERVAL = '2 hours';
// Redis lease so only one machine per region runs the sweep concurrently;
// slightly under the interval so the next tick can re-acquire promptly.
const REGION_LOCK_TTL_SECONDS = 25;

/**
 * Server-driven settle for video jobs whose customers never poll back after
 * the upstream completes. Runs in the control-api process on every configured
 * runtime region. Each tick:
 *   1. Acquires a per-region Redis lock (no thundering herd across machines).
 *   2. Pulls in-progress / pending rows, oldest first.
 *   3. Calls the same poll-and-settle helper as the customer GET path —
 *      idempotent via markVideoJobTerminal's atomic gate.
 * Returns a stop() to clear the interval at shutdown.
 */
export async function startVideoSweeper(
  app: FastifyInstance,
  intervalMs = 30_000,
): Promise<() => void> {
  const adapters = await buildVideoAdapters();
  const redis = getRedisClient();

  async function tick(): Promise<void> {
    try {
      await fanOutRuntimeRegions(async (runtimePool, region) => {
        try {
        // Per-region lock — first machine to grab it does the work for the tick.
        const lockKey = `ai_video_sweep:${region}`;
        const acquired = await redis.set(
          lockKey, String(process.pid),
          'EX', REGION_LOCK_TTL_SECONDS, 'NX',
        );
        if (acquired !== 'OK') return;

        let rows: VideoJobRow[];
        try {
          const r = await runtimePool.query<VideoJobRow>(
            `SELECT * FROM ai_video_jobs
             WHERE status IN ('pending', 'in_progress')
               AND created_at > NOW() - INTERVAL '${SWEEP_LOOKBACK_INTERVAL}'
             ORDER BY created_at ASC
             LIMIT $1`,
            [SWEEP_BATCH_SIZE],
          );
          rows = r.rows;
        } catch (err: any) {
          // 42P01 = relation does not exist — region runtime DB hasn't run the
          // migration (or has no apps yet). Skip silently rather than spamming
          // every tick; once the migration lands, the sweeper will pick up.
          if (err?.code === '42P01') return;
          throw err;
        }
        if (rows.length === 0) return;
        app.log.info({ region, count: rows.length }, 'video-sweeper: processing batch');

        for (const job of rows) {
          const organizationId = await resolveOrgFromApp(runtimePool, job.app_id);
          const ctx: RouteContext = {
            platformPool: app.controlDb, runtimePool, redis,
            adapters, markupPct: parseFloat(job.markup_pct),
            appId: job.app_id, organizationId, userId: job.user_id, region,
          };
          try {
            await pollAndSettleVideoJob(ctx, job);
          } catch (err) {
            app.log.warn({ err, jobId: job.id, region }, 'video-sweeper: poll/settle failed');
          }
        }
        } catch (err) {
          app.log.warn({ err, region }, 'video-sweeper: region tick failed');
        }
      });
    } catch (err) {
      app.log.error({ err }, 'video-sweeper tick failed');
    }
  }

  // First tick fires after one interval (skip work during route boot).
  const handle = setInterval(() => { void tick(); }, intervalMs);
  app.log.info({ intervalMs, regions: Object.keys(config.runtimeDb.urlsByRegion) }, 'video-sweeper: started');
  return () => clearInterval(handle);
}
