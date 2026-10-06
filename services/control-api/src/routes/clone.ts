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
  RESOURCE_CONFLICT,
} from '@butterbase/shared/error-types';

/**
 * Job modes the generic retry endpoint refuses. Every one of them has a start
 * route that performs admission checks a retry would skip; see the comment at
 * the refusal itself. Kept as an explicit list rather than "anything that is
 * not clone/update" so a future mode has to make the decision consciously.
 */
const RETRY_REFUSED_MODES = ['promote', 'staging_create', 'staging_reset'] as const;

const FRESH_START_ROUTE = {
  promote: { verb: 'promote', route: 'POST /v1/apps/{prod_app_id}/staging/promote' },
  staging_create: { verb: 'staging create', route: 'POST /v1/apps/{prod_app_id}/staging' },
  staging_reset: { verb: 'staging reset', route: 'POST /v1/apps/{prod_app_id}/staging/reset' },
} as const;

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
    // This endpoint is mode-agnostic by construction: it takes any job id the
    // caller owns. Modes added after it was written (Task 3's staging_create /
    // promote / staging_reset) inherited a retry path that skips EVERY
    // admission check their own start-route performs, which for promote means
    // an unreviewed production deploy: a week-old failed promote re-enqueued
    // here republishes a stale pinned source_snapshot_id and redeploys an old
    // staging bundle onto a live production frontend, with no
    // buildPromotePreview, no destructive-DDL preflight and no in-flight
    // re-check. (executePromote's filterAdditive still blocks destructive DDL,
    // so it is not data loss — but it is still a deploy nobody reviewed.)
    //
    // Refused rather than gated. A retry re-runs a job pinned to the state of
    // the world when it was created; a fresh operation re-previews against the
    // state of the world now, which IS the safety the retry path skips. For
    // these three modes the proper route is cheap and idempotent-ish
    // (startPromote re-previews, startStaging 409s if staging already exists,
    // startStagingReset re-checks for an in-flight promote at both admission
    // and execution time), so there is nothing a retry buys that a fresh call
    // does not, and plenty it loses. Refusing also makes the 23505 against
    // idx_template_clone_jobs_one_promote structurally unreachable from here
    // rather than something to catch after the fact.
    //
    // 'clone' and 'update' are deliberately NOT in this set — their retry
    // behaviour is unchanged.
    if (RETRY_REFUSED_MODES.includes(job.mode as (typeof RETRY_REFUSED_MODES)[number])) {
      const { route, verb } = FRESH_START_ROUTE[job.mode as keyof typeof FRESH_START_ROUTE];
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Cannot retry a '${job.mode}' job.`,
        remediation:
          `Start a fresh ${verb} instead: ${route}. A retry would re-run this job against `
          + 'the state it was created in, skipping the checks that run when the operation '
          + 'is started normally.',
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

    // incrementRetry flips status back to 'pending', which re-enters the
    // partial unique indexes on (dest_app_id) WHERE status NOT IN
    // ('completed','failed') — idx_template_clone_jobs_one_update (migration
    // 111) and idx_template_clone_jobs_one_promote (116). Refusing the promote
    // modes above puts the promote index out of reach from here, but the update
    // index is still live: the staleness gate only looks for a newer COMPLETED
    // update, so an update already IN FLIGHT for the same dest app raises a raw
    // 23505 that used to leak as a 500. It is a conflict, so report it as one.
    // The success path for clone and update is untouched.
    try {
      await incrementRetry(app.controlDb, job_id);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send(createAgentError({
          code: RESOURCE_CONFLICT,
          message: 'Another job for this app is already in flight.',
          remediation: 'Wait for the in-progress job to finish, then retry this one.',
          documentation_url: getDocUrl(RESOURCE_CONFLICT),
        }));
      }
      throw err;
    }
    await enqueueCloneTask(job.source_app_id, job.source_region, job.id);
    return reply.send({ job_id: job.id, status: 'pending' });
  });
}
