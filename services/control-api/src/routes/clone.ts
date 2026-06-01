// Routing decision: non-app-scoped routes work fine in this Fastify server
// (see init.ts `/apps`, `/init`, and hackathons-public.ts `/v1/public/...`).
// The API gateway does NOT require `/v1/:app_id/...` prefixing — routes are
// matched by exact path. We therefore use the plain forms:
//   GET  /v1/clone-jobs/:job_id
//   POST /v1/clone-jobs/:job_id/retry
// The clone-create route is naturally scoped under the source app:
//   POST /v1/templates/:source_app_id/clone

import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../utils/require-auth.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { createCloneJob, getCloneJob, incrementRetry } from '../services/clone-jobs.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
} from '@butterbase/shared/error-types';

/**
 * Insert a 'clone' row into the source app's region neon_tasks queue.
 * A partial unique index (idx_neon_tasks_active_unique) prevents two
 * pending/processing tasks of the same (app_id, task_type), so retry
 * needs to clear any still-active prior task first — the clone job's
 * 'failed' status flips on the worker's first failure, but the neon_task
 * row stays 'pending' through backoff retries until maxAttempts.
 */
async function enqueueCloneTask(
  sourceAppId: string,
  sourceRegion: string,
  jobId: string,
): Promise<void> {
  const runtimePool = getRuntimeDbPool(config.runtimeDb, sourceRegion);
  await runtimePool.query(
    `DELETE FROM neon_tasks
     WHERE app_id = $1 AND task_type = 'clone' AND status IN ('pending', 'processing')`,
    [sourceAppId],
  );
  await runtimePool.query(
    `INSERT INTO neon_tasks (app_id, task_type, task_meta) VALUES ($1, 'clone', $2)`,
    [sourceAppId, JSON.stringify({ job_id: jobId })],
  );
}

export function cloneRoutes(app: FastifyInstance) {
  // POST /v1/templates/:source_app_id/clone
  app.post('/v1/templates/:source_app_id/clone', async (request, reply) => {
    const { source_app_id } = request.params as { source_app_id: string };
    const body = (request.body ?? {}) as { name?: string; region?: string; dest_region?: string };
    const userId = requireUserId(request);

    // getRuntimeDbForApp throws AppNotFoundError if the app isn't in
    // user_app_index. We translate to the same generic 404 we use for the
    // non-public case below, to avoid leaking existence information.
    let sourcePool;
    try {
      sourcePool = await getRuntimeDbForApp(app.controlDb, source_app_id);
    } catch (err) {
      if (err instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Source app not found or not public.',
          remediation: 'Verify the app id and that the source app has visibility=public.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      throw err;
    }

    const srcRow = await sourcePool.query<{
      id: string;
      visibility: string;
      region: string;
      repo_latest_snapshot: string | null;
    }>(
      `SELECT id, visibility, region, repo_latest_snapshot FROM apps WHERE id = $1`,
      [source_app_id],
    );
    const src = srcRow.rows[0];
    if (!src || src.visibility !== 'public') {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Source app not found or not public.',
        remediation: 'Only public apps are clonable.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    if (!src.repo_latest_snapshot) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Source app has no repo snapshot yet.',
        remediation: 'The source must run `butterbase repo push` at least once before it can be cloned.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // Cap simultaneous non-terminal clone jobs per user at 3.
    const inflightResult = await app.controlDb.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM template_clone_jobs
        WHERE requested_by_user_id = $1
          AND status NOT IN ('completed', 'failed')`,
      [userId],
    );
    if (inflightResult.rows[0].c >= 3) {
      return reply.code(429).send({
        error: {
          code: 'CLONE_LIMIT_INFLIGHT',
          message: 'You already have 3 clones in progress. Wait for one to complete or fail.',
        },
      });
    }

    // Accept dest_region (preferred) or the legacy region alias.
    const destRegion = body.dest_region ?? body.region ?? src.region;
    const job = await createCloneJob(app.controlDb, {
      sourceAppId: source_app_id,
      sourceSnapshotId: src.repo_latest_snapshot,
      sourceRegion: src.region,
      destRegion,
      requestedByUserId: userId,
      destAppName: body.name,
    });

    await enqueueCloneTask(source_app_id, src.region, job.id);

    return reply.send({ job_id: job.id, status: 'pending' });
  });

  // GET /v1/clone-jobs/:job_id
  app.get('/v1/clone-jobs/:job_id', async (request, reply) => {
    const { job_id } = request.params as { job_id: string };
    const userId = requireUserId(request);
    const job = await getCloneJob(app.controlDb, job_id);
    if (!job || job.requested_by_user_id !== userId) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Clone job not found.',
        remediation: 'Check the job id; only the requestor can read the job.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    return reply.send({
      job_id: job.id,
      status: job.status,
      source_app_id: job.source_app_id,
      dest_app_id: job.dest_app_id,
      retry_count: job.retry_count,
      error_message: job.error_message,
      created_at: job.created_at.toISOString(),
      completed_at: job.completed_at?.toISOString() ?? null,
    });
  });

  // POST /v1/clone-jobs/:job_id/retry
  app.post('/v1/clone-jobs/:job_id/retry', async (request, reply) => {
    const { job_id } = request.params as { job_id: string };
    const userId = requireUserId(request);
    const job = await getCloneJob(app.controlDb, job_id);
    if (!job || job.requested_by_user_id !== userId) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Clone job not found.',
        remediation: 'Check the job id; only the requestor can retry.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }
    if (job.status !== 'failed') {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Cannot retry a job in status '${job.status}'.`,
        remediation: 'Retry only works on failed jobs.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    await incrementRetry(app.controlDb, job_id);
    await enqueueCloneTask(job.source_app_id, job.source_region, job.id);
    return reply.send({ job_id: job.id, status: 'pending' });
  });
}
