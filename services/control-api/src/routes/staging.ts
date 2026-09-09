// Routes are matched by exact path; the gateway does not require /v1/:app_id
// prefixing (see the note at the top of clone.ts). Staging is naturally scoped
// under the production app:
//   POST   /v1/apps/:app_id/staging  — create a staging environment
//   GET    /v1/apps/:app_id/staging  — read the prod->staging link
//   DELETE /v1/apps/:app_id/staging  — unlink only (see comment below)
//   GET    /v1/apps/:app_id/staging/env-overrides — override key names
//   PUT    /v1/apps/:app_id/staging/env-overrides — set staging's env values

import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../utils/require-auth.js';
import { rateLimitAllowList } from '../plugins/rate-limit.js';
import { enqueueCloneTask } from '../services/clone-task-queue.js';
import { startStaging, sendStartStagingFailure } from '../services/start-staging.js';
import {
  getEnvironmentLink, getEnvironmentLinkWithPauseState, unlinkEnvironment,
} from '../services/app-environments.js';
import { getLatestStagingJob } from '../services/clone-jobs.js';
import { getRuntimeDbForApp, resolveAppHomeRegion } from '../services/region-resolver.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { startPromote } from '../services/promote-jobs.js';
import { buildPromotePreview } from '../services/promote-preview.js';
import { startStagingReset } from '../services/staging-reset.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import {
  setStagingOverrides, getStagingOverrides, applyStagingOverridesToAppEnv,
} from '../services/staging-overrides.js';
import { validateEnvKeys } from '../lib/env-vars.js';
import { invalidateFunctionCache } from '../utils/cache-invalidation.js';
import { logFromRequest } from '../services/audit/with-audit.js';
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
    const link = await getEnvironmentLinkWithPauseState(runtimeDb, app_id);
    if (!link) return reply.send({ staging_app_id: null });

    // Job pointer is best-effort scoping only: ownership of app_id was
    // already confirmed above, and getLatestStagingJob only ever selects
    // staging_create/staging_reset rows keyed off app_id or promote rows
    // keyed off app_id as dest — never a row belonging to some other app,
    // so this cannot leak another app's job.
    const lastJob = await getLatestStagingJob(app.controlDb, app_id);

    return reply.send({
      staging_app_id: link.staging_app_id,
      created_at: link.created_at.toISOString(),
      last_promoted_at: link.last_promoted_at?.toISOString() ?? null,
      last_reset_at: link.last_reset_at?.toISOString() ?? null,
      paused: link.staging_paused,
      paused_at: link.staging_paused_at?.toISOString() ?? null,
      paused_reason: link.staging_paused_reason,
      ...(lastJob
        ? {
            last_job: {
              job_id: lastJob.job_id,
              mode: lastJob.mode,
              status: lastJob.status,
              created_at: lastJob.created_at.toISOString(),
            },
          }
        : { last_job: null }),
    });
  });

  // Unlinks the prod<->staging pairing only — it does NOT delete the staging
  // app. Deleting the staging app itself must go through the normal
  // app-deletion path so Neon project teardown and the orphan reconciler stay
  // in charge of it; this route only removes the app_environments row.
  //
  // WHAT IS LEFT BEHIND, AND WHY IT IS NAMED. Since the app-copy engine was
  // wired into staging creation, a staging app holds a real copy of
  // production's rows, `app_users` and uploaded files — a second copy of the
  // customer's personal data. Unlinking deletes the `app_environments` row and
  // nothing else, so that copy survives; and because the idle reaper scopes
  // every one of its statements through `app_environments`
  // (staging-reaper.ts), the app also drops out of automatic lifecycle
  // management for good. Keeping the app is the right conservative default —
  // this route must not destroy an environment the caller only asked to
  // unpair — but the retention must not be SILENT. The response names the
  // retained app id, says what it still holds, and gives the exact call that
  // removes it; the audit event records the same fact.
  app.delete('/v1/apps/:app_id/staging', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
    // Read the link BEFORE removing it — afterwards there is nothing left that
    // names which app was just orphaned.
    const link = await getEnvironmentLink(runtimeDb, app_id);
    await unlinkEnvironment(runtimeDb, app_id);

    const retainedAppId = link?.staging_app_id ?? null;

    logFromRequest(request, {
      appId: app_id,
      category: 'admin',
      eventType: 'staging.unlink',
      action: 'delete',
      resourceType: 'app',
      resourceId: retainedAppId ?? app_id,
      // Ids and booleans only — never a row, a user or a filename.
      eventData: {
        retained_staging_app_id: retainedAppId,
        retains_production_data_copy: retainedAppId != null,
      },
      success: true,
    });

    return reply.send({
      deleted: true,
      // Null when there was no link to begin with (the call is idempotent), so
      // clients can branch on presence alone.
      retained_staging_app_id: retainedAppId,
      ...(retainedAppId
        ? {
            retention_notice:
              `Unlinked only. Staging app ${retainedAppId} still exists and still holds its copy of `
              + 'this app\'s production data — rows, auth users and uploaded files. It is no longer '
              + 'covered by staging idle-pausing, because that is scoped through the link you just '
              + `removed. Delete it with: DELETE /apps/${retainedAppId}`,
          }
        : {}),
    });
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

  // GET /v1/apps/:app_id/staging/env-overrides — key NAMES only, never values.
  //
  // Scoped under the PRODUCTION app id, like every other route in this file:
  // `assertCallerOwnsApp` is written for the production app, the owner's
  // mental model is "my app's staging", and the staging app id is an
  // implementation detail they never have to hold. The store is keyed on the
  // production app too (migration 053), so `app_id` is the identity end to end
  // and overrides exist independently of whether staging does.
  app.get('/v1/apps/:app_id/staging/env-overrides', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);
    const [overrides, link] = await Promise.all([
      getStagingOverrides(runtimeDb, app_id),
      getEnvironmentLink(runtimeDb, app_id),
    ]);
    return reply.send({
      staging_app_id: link?.staging_app_id ?? null,
      keys: Object.keys(overrides),
    });
  });

  // PUT /v1/apps/:app_id/staging/env-overrides — replace the staging app's
  // env var overrides.
  //
  // These are the values a staging app uses INSTEAD of production's. Staging
  // never inherits a production env var VALUE (clone-app-env.ts's
  // `withholdInheritedValues`), so without an override here a key exists on the
  // staging app with an empty value and functions needing it fail loudly.
  //
  // Writes through twice, on purpose: to `staging_env_overrides` (durable, keyed
  // on the production app, and applied by the clone-time replay) and straight
  // into the staging app's live `app_env_vars` blob (what the runtime actually
  // reads). The second write MERGES — values the owner set directly via
  // `PATCH /v1/:appId/env` survive unless an override names the same key.
  //
  // Works with NO staging environment yet: the store is keyed on the production
  // app, so an owner can stage sandbox values first and have staging come up
  // working on the very first create instead of coming up broken. When there is
  // no staging app the write-through is simply skipped — `applied_to_staging`
  // in the response says which happened.
  app.put('/v1/apps/:app_id/staging/env-overrides', {
    config: {
      // Looser than create/reset (5/hour): this is a config write, not a
      // provisioning job. Still bounded — it decrypts and re-encrypts a blob
      // and fans out cache invalidation per function.
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 30,
        timeWindow: '1 hour',
        keyGenerator: (req) => {
          const userId = req.auth?.userId;
          return userId ? `user:${userId}:staging-env-overrides` : `ip:${req.ip}:staging-env-overrides`;
        },
      },
    },
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);

    // Ownership BEFORE any side effect, and a generic 404 on non-ownership so
    // this never leaks whether an app id exists.
    if (!(await assertCallerOwnsApp(app, app_id, userId, request.auth?.organizationId))) {
      return reply.code(404).send(notFound(app_id));
    }

    const body = request.body as { env_overrides?: unknown } | undefined;
    const raw = body?.env_overrides;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'env_overrides must be an object of string key/value pairs.',
        remediation: 'Example: {"env_overrides": {"STRIPE_SECRET": "sk_test_..."}}. Pass {} to clear all overrides.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    const badValue = entries.find(([, v]) => typeof v !== 'string');
    if (badValue) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `env_overrides["${badValue[0]}"] must be a string.`,
        remediation: 'Override values are strings. To remove an override, omit the key — PUT replaces the whole set.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    const badKey = validateEnvKeys(entries.map(([k]) => k));
    if (badKey) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Reserved key: "${badKey.key}" — keys starting with BUTTERBASE_ are reserved for platform use.`,
        remediation: 'Rename the key.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }
    const overrides = Object.fromEntries(entries) as Record<string, string>;

    const runtimeDb = await getRuntimeDbForApp(app.controlDb, app_id);

    // The durable write, keyed on the production app. Happens whether or not a
    // staging environment exists yet.
    await setStagingOverrides(runtimeDb, app_id, overrides, userId);

    const link = await getEnvironmentLink(runtimeDb, app_id);
    let appliedKeys = Object.keys(overrides);
    let invalidated: { count: number; failed?: number } | undefined;
    if (link) {
      ({ appliedKeys } = await applyStagingOverridesToAppEnv(
        runtimeDb, link.staging_app_id, overrides, userId,
      ));

      // Fan out cache invalidation so already-warm staging functions pick the
      // new values up. allSettled + a warn: the 5-min LRU TTL is the backstop,
      // and a Redis blip must not fail a write that already committed. Mirrors
      // routes/app-env.ts.
      const fns = await runtimeDb.query<{ name: string }>(
        `SELECT name FROM app_functions WHERE app_id = $1 AND deleted_at IS NULL`,
        [link.staging_app_id],
      );
      const settled = await Promise.allSettled(
        fns.rows.map((r) => invalidateFunctionCache(link.staging_app_id, r.name)),
      );
      const failed = settled.filter((s) => s.status === 'rejected').length;
      if (failed > 0) {
        request.log.warn(
          { app_id, staging_app_id: link.staging_app_id, failed },
          '[staging] some function cache invalidations failed after env override write',
        );
      }
      invalidated = { count: settled.length - failed, ...(failed > 0 ? { failed } : {}) };
    }

    // Key names only — an override VALUE is never echoed back or logged.
    logFromRequest(request, {
      appId: link?.staging_app_id ?? app_id,
      category: 'admin',
      eventType: 'staging.env_overrides.update',
      action: 'update',
      resourceType: 'app',
      resourceId: link?.staging_app_id ?? app_id,
      eventData: { env_var_keys: appliedKeys, applied_to_staging: link != null },
      success: true,
    });

    return reply.send({
      staging_app_id: link?.staging_app_id ?? null,
      keys: appliedKeys,
      // False means "stored, and will be applied when staging is created" —
      // never a silent partial success.
      applied_to_staging: link != null,
      ...(invalidated ? { invalidated } : {}),
    });
  });

  // POST /v1/apps/:app_id/staging/reset — discards the staging app's data
  // and re-seeds it from production. DIRECTION IS REVERSED FROM PROMOTE:
  // production is the source, staging is the destination — see
  // staging-reset.ts's header comment. Never writes to production.
  app.post('/v1/apps/:app_id/staging/reset', {
    config: {
      // Matches the staging-create route above: reset is at least as
      // expensive (a full truncate + re-seed of every seed table) and more
      // destructive (it discards staging's current data unconditionally).
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: (req) => {
          const userId = req.auth?.userId;
          return userId ? `user:${userId}:staging-reset` : `ip:${req.ip}:staging-reset`;
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

    const result = await startStagingReset({
      controlDb: app.controlDb, prodAppId: app_id, userId, orgId,
    });
    if (!result.ok) {
      if (result.code === 'IN_FLIGHT') {
        return reply.code(409).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: result.message,
          remediation: 'Wait for the in-progress promote to finish, then retry the reset.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      if (result.code === 'RESET_IN_FLIGHT') {
        return reply.code(409).send(createAgentError({
          code: VALIDATION_INVALID_SCHEMA,
          message: result.message,
          remediation: 'Wait for the in-progress reset to finish, then retry.',
          documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
        }));
      }
      return reply.code(404).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: result.message,
        remediation: 'Create a staging environment first.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // Enqueued only after the control-plane job row committed, matching
    // every other route here. enqueueCloneTask's first argument is the
    // SOURCE app id — for a reset that is the PRODUCTION app (app_id), not
    // staging. neon_tasks is a per-region queue and the worker claims from
    // its own instanceRegion, so this must land in production's region.
    const region = await resolveAppHomeRegion(app.controlDb, app_id);
    await enqueueCloneTask(app_id, region, result.jobId);

    return reply.send({ job_id: result.jobId, status: 'pending' });
  });
}
