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
import { enqueueCloneTask } from '../services/clone-task-queue.js';
import {
  getCloneJob, incrementRetry,
  canRetryUpdateJob, hasNewerCompletedUpdate, UPDATE_RETRY_MAX_AGE_MS,
} from '../services/clone-jobs.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { resolveOrganizationId, assertOrgMember } from '../services/org-resolver.js';
import { startClone, sendStartCloneFailure } from '../services/start-clone.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
} from '@butterbase/shared/error-types';

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
      organization_id?: string;
      env_var_values?: Record<string, Record<string, string>>;
      auto_mint_api_key?: { fn_name: string; key: string }[];
    };
    const userId = requireUserId(request);

    // Resolve target org for the destination app. Precedence mirrors /init:
    //   1. Explicit body.organization_id — gated by membership check.
    //   2. Auth-bound org (bb_sk_* key's org, or JWT x-organization-id).
    //   3. Caller's personal org.
    let destOrgId: string;
    if (body.organization_id) {
      await assertOrgMember(app.controlDb, userId, body.organization_id);
      destOrgId = body.organization_id;
    } else {
      destOrgId = request.auth?.organizationId
        ?? await resolveOrganizationId(app.controlDb, userId);
    }

    // All clone admission rules live in startClone so the anonymous-redemption
    // route can reuse them verbatim rather than fork them.
    const result = await startClone({
      controlDb: app.controlDb,
      sourceAppId: source_app_id,
      userId,
      destOrgId,
      name: body.name,
      destRegion: body.dest_region ?? body.region,
      envVarValues: body.env_var_values,
      autoMintRequests: body.auto_mint_api_key,
      logger: request.log,
    });
    if (!result.ok) return sendStartCloneFailure(reply, result);

    // Enqueued only after the control-plane write succeeded: this INSERT lands
    // in a regional runtime DB, not the control DB.
    await enqueueCloneTask(source_app_id, result.sourceRegion, result.jobId);

    return reply.send({
      job_id: result.jobId,
      status: 'pending',
      dest_region: result.destRegion,
      ...(result.redirectedFromRegion
        ? {
            dest_region_redirected_from: result.redirectedFromRegion,
            notice: `Region "${result.redirectedFromRegion}" is temporarily closed to new apps; this clone will be created in "${result.destRegion}" instead.`,
          }
        : {}),
    });
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
    // Retrying an update is only safe while the fork is still in the state this
    // job left it in. A stale retry re-enters the worker's 'republish' path,
    // which by design skips the divergence gate, so it would overwrite whatever
    // the owner has done to the fork since. Clone-mode jobs are unaffected:
    // their destination is an app nobody else can have touched.
    if (job.mode === 'update' && job.dest_app_id) {
      const superseded = await hasNewerCompletedUpdate(
        app.controlDb, job.dest_app_id, job.id, job.created_at,
      );
      const { allowed, reason } = canRetryUpdateJob({
        lastUpdatedAt: job.updated_at,
        now: new Date(),
        hasNewerCompletedUpdate: superseded,
      });
      if (!allowed) {
        const detail = reason === 'superseded'
          ? 'This app has been updated by a newer job since this one failed.'
          : `This update failed more than ${Math.round(UPDATE_RETRY_MAX_AGE_MS / 60000)} minutes ago.`;
        return reply.code(400).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: `Cannot retry this template update. ${detail}`,
          remediation:
            'Start a fresh update instead: POST /v1/:app_id/template/update. A new job ' +
            're-checks the app against the template, so nothing you have changed since ' +
            'gets overwritten.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
    }

    await incrementRetry(app.controlDb, job_id);
    await enqueueCloneTask(job.source_app_id, job.source_region, job.id);
    return reply.send({ job_id: job.id, status: 'pending' });
  });
}
