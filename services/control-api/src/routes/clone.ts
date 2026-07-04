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
import { rateLimitAllowList } from '../plugins/rate-limit.js';
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
 *
 * Each clone job gets its own neon_tasks row.  The unique constraint
 * (idx_neon_tasks_active_unique_non_clone) applies only to non-clone task
 * types, so concurrent clone tasks for the same source app coexist safely.
 * The worker claims tasks with FOR UPDATE SKIP LOCKED and processes them
 * sequentially without interfering with sibling clone tasks.
 */
async function enqueueCloneTask(
  sourceAppId: string,
  sourceRegion: string,
  jobId: string,
): Promise<void> {
  const runtimePool = getRuntimeDbPool(config.runtimeDb, sourceRegion);
  await runtimePool.query(
    `INSERT INTO neon_tasks (app_id, task_type, task_meta) VALUES ($1, 'clone', $2)`,
    [sourceAppId, JSON.stringify({ job_id: jobId })],
  );
}

export function cloneRoutes(app: FastifyInstance) {
  // POST /v1/templates/:source_app_id/clone
  app.post('/v1/templates/:source_app_id/clone', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: (req) => {
          // auth plugin runs its onRequest hook before rate-limit (registered first),
          // so req.auth.userId is available here.
          const userId = req.auth?.userId;
          return userId ? `user:${userId}:clone` : `ip:${req.ip}:clone`;
        },
      },
    },
  }, async (request, reply) => {
    const { source_app_id } = request.params as { source_app_id: string };
    const body = (request.body ?? {}) as {
      name?: string;
      region?: string;
      dest_region?: string;
      env_var_values?: Record<string, Record<string, string>>;
      auto_mint_api_key?: { fn_name: string; key: string }[];
    };
    const userId = requireUserId(request);

    // getRuntimeDbForApp throws AppNotFoundError if the app isn't in
    // org_app_index. We translate to the same generic 404 we use for the
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

    // Reject if ANY user in ANY region already owns an app with the
    // requested name. org_app_index is the cross-region platform-tier
    // projection of (organization_id, region, app_name), so a single lookup against
    // it catches global collisions without fanning out to every regional
    // runtime DB. We need global uniqueness because the CF Pages project
    // name is derived from the app name and CF Pages projects share one
    // account-wide namespace; two apps with the same slug would collide
    // at frontend-deploy time. Skipped when name is omitted — the worker
    // will fall back to `Clone of {source}`, which is allowed to repeat
    // (the source id makes that string globally unique).
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      const requestedName = body.name.trim();
      const collision = await app.controlDb.query<{ app_id: string }>(
        `SELECT app_id FROM org_app_index WHERE app_name = $1 LIMIT 1`,
        [requestedName],
      );
      if (collision.rows.length > 0) {
        return reply.code(409).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: `The app name "${requestedName}" is already taken.`,
          remediation: 'Pick a different name.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
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

    // Validate env_var_values shape: must be plain object whose values are plain
    // objects with string values. Reject anything else with a 400 — the caller
    // likely sent a malformed payload and silent acceptance would persist garbage.
    if (body.env_var_values !== undefined) {
      if (typeof body.env_var_values !== 'object' || body.env_var_values === null || Array.isArray(body.env_var_values)) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'env_var_values must be an object mapping function names to {key: value} objects.',
          remediation: 'Send env_var_values as { fn_name: { KEY: "value" } }.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      for (const [fn, vars] of Object.entries(body.env_var_values)) {
        if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
          return reply.code(400).send(createAgentError({
            code: VALIDATION_INVALID_SCHEMA,
            message: `env_var_values["${fn}"] must be an object of {key: value} strings.`,
            remediation: 'Send env_var_values as { fn_name: { KEY: "value" } }.',
            documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          }));
        }
        for (const [k, v] of Object.entries(vars)) {
          if (typeof v !== 'string') {
            return reply.code(400).send(createAgentError({
              code: VALIDATION_INVALID_SCHEMA,
              message: `env_var_values["${fn}"]["${k}"] must be a string.`,
              remediation: 'Env var values must be strings.',
              documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
            }));
          }
        }
      }
    }

    if (body.auto_mint_api_key !== undefined) {
      if (!Array.isArray(body.auto_mint_api_key)) {
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: 'auto_mint_api_key must be an array of {fn_name, key} objects.',
          remediation: 'Send auto_mint_api_key as [{ fn_name: "fn", key: "BUTTERBASE_API_KEY" }].',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      for (const r of body.auto_mint_api_key) {
        if (typeof r?.fn_name !== 'string' || typeof r?.key !== 'string') {
          return reply.code(400).send(createAgentError({
            code: VALIDATION_INVALID_SCHEMA,
            message: 'auto_mint_api_key entries must have string fn_name and key.',
            remediation: 'Send auto_mint_api_key as [{ fn_name: "fn", key: "BUTTERBASE_API_KEY" }].',
            documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
          }));
        }
      }
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
      pendingEnvVarValues: body.env_var_values,
      autoMintRequests: body.auto_mint_api_key,
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
      warnings: (job.warnings ?? []) as string[],
      unfilled_env_vars: job.unfilled_env_vars ?? null,
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
