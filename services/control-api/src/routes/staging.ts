// Routes are matched by exact path; the gateway does not require /v1/:app_id
// prefixing (see the note at the top of clone.ts). Staging is naturally scoped
// under the production app:
//   POST   /v1/apps/:app_id/staging  — create a staging environment
//   GET    /v1/apps/:app_id/staging  — read the prod->staging link
//   DELETE /v1/apps/:app_id/staging  — unlink only (see comment below)

import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../utils/require-auth.js';
import { rateLimitAllowList } from '../plugins/rate-limit.js';
import { enqueueCloneTask } from '../services/clone-task-queue.js';
import { startStaging, sendStartStagingFailure } from '../services/start-staging.js';
import { getEnvironmentLink, unlinkEnvironment } from '../services/app-environments.js';
import { getRuntimeDbForApp, resolveAppHomeRegion } from '../services/region-resolver.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { startPromote } from '../services/promote-jobs.js';
import { buildPromotePreview } from '../services/promote-preview.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import {
  RESOURCE_NOT_FOUND,
  VALIDATION_INVALID_SCHEMA,
  EXTERNAL_DB_ERROR,
} from '@butterbase/shared/error-types';

function notFound(appId: string) {
  return createAgentError({
    code: RESOURCE_NOT_FOUND,
    message: 'App not found.',
    remediation: `Verify the app id (${appId}) and that you have access to it.`,
    documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
  });
}

/**
 * Confirms the caller may act on `app_id` before any staging read/write
 * happens. `AppResolver.resolveApp` throws AppNotFoundError both when the app
 * doesn't exist and when the caller doesn't own it / isn't a member of its
 * org — deliberately indistinguishable, so this never leaks whether a given
 * app id exists to someone who can't access it. Without this check, GET/DELETE
 * (and, transitively, POST) would let any authenticated user read or unlink
 * another user's staging link by guessing an app_id.
 */
async function assertCallerOwnsApp(
  app: FastifyInstance, appId: string, userId: string, orgId: string | null | undefined,
): Promise<boolean> {
  try {
    await AppResolver.resolveApp(app.controlDb, appId, userId, orgId ?? null);
    return true;
  } catch (err) {
    if (err instanceof AppNotFoundError) return false;
    throw err;
  }
}

export function stagingRoutes(app: FastifyInstance) {
  app.post('/v1/apps/:app_id/staging', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: (req) => {
          // auth plugin runs its onRequest hook before rate-limit (registered first),
          // so req.auth.userId is available here.
          const userId = req.auth?.userId;
          return userId ? `user:${userId}:staging` : `ip:${req.ip}:staging`;
        },
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const orgId = request.auth?.organizationId
      ?? await resolveOrganizationId(app.controlDb, userId);

    const result = await startStaging({
      controlDb: app.controlDb,
      prodAppId: app_id,
      userId,
      orgId,
      logger: request.log,
    });
    if (!result.ok) return sendStartStagingFailure(reply, result);

    // Enqueued only after the control-plane write committed — this INSERT
    // targets a regional runtime DB, mirroring the ordering in clone.ts.
    await enqueueCloneTask(app_id, result.region, result.jobId);

    return reply.send({
      job_id: result.jobId,
      staging_name: result.stagingName,
      staging_subdomain: result.stagingSubdomain,
      region: result.region,
      status: 'pending',
    });
  });

  app.get('/v1/apps/:app_id/staging', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
    const link = await getEnvironmentLink(runtimeDb, app_id);
    if (!link) return reply.send({ staging_app_id: null });
    return reply.send({
      staging_app_id: link.staging_app_id,
      created_at: link.created_at.toISOString(),
      last_promoted_at: link.last_promoted_at?.toISOString() ?? null,
      last_reset_at: link.last_reset_at?.toISOString() ?? null,
    });
  });

  // Unlinks the prod<->staging pairing only — it does NOT delete the staging
  // app. Deleting the staging app itself must go through the normal
  // app-deletion path so Neon project teardown and the orphan reconciler stay
  // in charge of it; this route only removes the app_environments row.
  app.delete('/v1/apps/:app_id/staging', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
    await unlinkEnvironment(runtimeDb, app_id);
    return reply.send({ deleted: true });
  });

  // GET /v1/apps/:app_id/staging/promote/preview — read-only dry run of a
  // promote. Never touches template_clone_jobs; safe to call repeatedly.
  app.get('/v1/apps/:app_id/staging/promote/preview', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
    const link = await getEnvironmentLink(runtimeDb, app_id);
    if (!link) {
      return reply.send({ can_promote: false, additive: [], blocked: [], ignored_removals: [] });
    }

    // Staging is pinned to the production app's region (start-staging.ts),
    // so both rows live in this same runtimeDb — same lookup shape as
    // startPromote (promote-jobs.ts), which getAppPoolForApp needs the real
    // db_name for (it does not default to app_id).
    const [prodRow, stagingRow] = await Promise.all([
      runtimeDb.query<{ db_name: string }>('SELECT db_name FROM apps WHERE id = $1', [app_id]),
      runtimeDb.query<{ db_name: string }>(
        'SELECT db_name FROM apps WHERE id = $1', [link.staging_app_id],
      ),
    ]);
    if (!prodRow.rows[0] || !stagingRow.rows[0]) {
      return reply.send({ can_promote: false, additive: [], blocked: [], ignored_removals: [] });
    }

    const stagingPool = await getAppPoolForApp(
      app.controlDb, link.staging_app_id, stagingRow.rows[0].db_name,
    );
    const prodPool = await getAppPoolForApp(app.controlDb, app_id, prodRow.rows[0].db_name);
    const preview = await buildPromotePreview(stagingPool, prodPool);

    return reply.send({
      can_promote: preview.canPromote,
      additive: preview.additive.map((s) => s.sql),
      blocked: preview.blocked.map((s) => s.sql),
      // Not additive, not blocked — informational: table/column removals
      // staging made that promote will never apply to production. Dropping
      // this would wrongly imply the preview is exhaustive with just the
      // other two lists.
      ignored_removals: preview.ignoredRemovals,
    });
  });

  // POST /v1/apps/:app_id/staging/promote — applies staging's schema, RLS,
  // functions, DOs, config, repo and deployed frontend to production. Data
  // is never promoted.
  app.post('/v1/apps/:app_id/staging/promote', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const orgId = request.auth?.organizationId
      ?? await resolveOrganizationId(app.controlDb, userId);

    let result;
    try {
      result = await startPromote({
        controlDb: app.controlDb, prodAppId: app_id, userId, orgId,
      });
    } catch (err) {
      // startPromote's own 23505 compensating catch (concurrent promote
      // race) can itself throw if its deleteCloneJob cleanup fails — that
      // propagates out of startPromote unhandled. Never leak a raw error.
      request.log.error({ err, app_id }, 'startPromote threw unexpectedly');
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Failed to start the promote. Please try again.',
        remediation: 'Retry the operation. If the problem persists, contact support.',
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR),
      }));
    }

    if (!result.ok) {
      // result.message may name specific blocked SQL statements
      // (formatBlockedStatements) — surfaced verbatim so the user learns
      // exactly which change is stuck.
      return reply.code(409).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: result.message,
        remediation: 'Resolve the listed problem, then run the promote again.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    try {
      // Enqueued only after the control-plane write committed, matching
      // clone.ts and the staging-create route above. neon_tasks is a
      // per-region queue and the worker claims from its own instanceRegion,
      // so this MUST land in the production app's region — staging is
      // pinned to that same region at creation time (start-staging.ts), so
      // resolving either app's region here is equivalent. The task itself
      // is queued against the SOURCE app (staging), matching clone.ts's
      // convention and startPromote's job row (source = staging app).
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
      const link = await getEnvironmentLink(runtimeDb, app_id);
      await enqueueCloneTask(link!.staging_app_id, region, result.jobId);
    } catch (err) {
      // The job row already exists at this point (startPromote succeeded);
      // only the enqueue failed. Do not leak a raw error — the job id is
      // enough for support to recover it manually.
      request.log.error(
        { err, app_id, jobId: result.jobId },
        'promote job created but failed to enqueue',
      );
      return reply.code(500).send(createAgentError({
        code: EXTERNAL_DB_ERROR,
        message: 'Promote job was created but could not be queued. Contact support with this job id.',
        remediation: `Contact support and reference job ${result.jobId}.`,
        documentation_url: getDocUrl(EXTERNAL_DB_ERROR),
      }));
    }

    return reply.send({ job_id: result.jobId, status: 'pending' });
  });
}
