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
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND } from '@butterbase/shared/error-types';

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
}
