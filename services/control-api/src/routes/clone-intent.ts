// POST /v1/templates/:source_app_id/clone-intent   (anonymous)
// POST /v1/clone-intents/:id/redeem                 (authenticated)
//
// The two halves of the signup-surviving clone flow. A visitor browsing the
// public templates site configures a clone before they have an account; the
// first route parks that configuration server-side (encrypted) and hands back
// an opaque intent id. After the visitor registers and lands back in the
// dashboard, the second route redeems that id and starts the clone as the
// now-authenticated user.
//
// The anonymous route deliberately does NOT call requireUserId — there is no
// Authorization header to require. Env var VALUES are secrets and must never
// appear in a response, an error message, or a log line: createCloneIntent
// encrypts them before they touch the database, and on redeem they go straight
// from loadRedeemableIntent into startClone without being echoed anywhere.

import type { FastifyInstance } from 'fastify';
import { rateLimitAllowList } from '../plugins/rate-limit.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import {
  createCloneIntent,
  loadRedeemableIntent,
  markIntentRedeemed,
} from '../services/clone-intents.js';
import { startClone, sendStartCloneFailure } from '../services/start-clone.js';
import { abandonDuplicateCloneJob } from '../services/clone-jobs.js';
import { enqueueCloneTask } from '../services/clone-task-queue.js';
import { resolveOrganizationId } from '../services/org-resolver.js';
import { requireUserId } from '../utils/require-auth.js';
import { validateEnvVarValues } from '../services/clone-validation.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import { AppNotFoundError } from '../services/app-resolver.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
} from '@butterbase/shared/error-types';

function sourceNotFound(reply: any) {
  // Deliberately identical whether the app doesn't exist or simply isn't
  // public — the response must not leak which is true.
  return reply.code(404).send(createAgentError({
    code: RESOURCE_NOT_FOUND,
    message: 'Source app not found.',
    remediation: 'Verify the app id and that the source app has visibility=public.',
    documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
  }));
}

export function cloneIntentRoutes(app: FastifyInstance): void {
  app.post('/v1/templates/:source_app_id/clone-intent', {
    config: {
      rateLimit: {
        allowList: rateLimitAllowList,
        max: 10,
        timeWindow: '1 hour',
        keyGenerator: (req) => `ip:${req.ip}:clone-intent`,
      },
    },
  }, async (request, reply) => {
    const { source_app_id } = request.params as { source_app_id: string };
    const body = (request.body ?? {}) as {
      name?: string;
      dest_region?: string;
      env_var_values?: Record<string, Record<string, string>>;
      auto_mint_api_key?: { fn_name: string; key: string }[];
    };

    // 1. Resolve the source app's home region. Translate AppNotFoundError to
    // the same non-leaking 404 used for a non-public app below.
    let sourceRegion: string;
    try {
      sourceRegion = await resolveAppHomeRegion(app.controlDb, source_app_id);
    } catch (err) {
      if (err instanceof AppNotFoundError) return sourceNotFound(reply);
      throw err;
    }

    // 2. Load visibility + snapshot from the region's runtime pool.
    const runtimePool = getRuntimeDbPool(config.runtimeDb, sourceRegion);
    const srcRow = await runtimePool.query<{
      id: string;
      visibility: string;
      repo_latest_snapshot: string | null;
    }>(
      `SELECT id, visibility, repo_latest_snapshot FROM apps WHERE id = $1`,
      [source_app_id],
    );
    const src = srcRow.rows[0];
    if (!src || src.visibility !== 'public') {
      return sourceNotFound(reply);
    }
    if (!src.repo_latest_snapshot) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Source app has no repo snapshot yet.',
        remediation: 'The source must run `butterbase repo push` at least once before it can be cloned.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // 3. Validate env_var_values shape (same rules as startClone — same
    // validator function, in fact).
    const envShape = validateEnvVarValues(body.env_var_values);
    if (!envShape.ok) {
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: envShape.message,
        remediation: 'Send env_var_values as { fn_name: { KEY: "value" } }.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    }

    // 4. Advisory name-collision check — LEGACY `pages` backend only.
    // App names are not a global namespace; subdomains are (migration 080's
    // `user_app_index_subdomain_uniq` is the only DB-level guarantee, and there
    // is no unique index on app_name). The clone worker deliberately inserts
    // the dest with `allowDuplicateName: true` and de-duplicates the SUBDOMAIN
    // instead, so duplicate names are expected, not exceptional.
    //
    // This mattered only for deployTemplatePageViaPages, which derives the CF
    // Pages project name from the app name and so needs account-wide
    // uniqueness. `deployViaWfp` keys off app.subdomain and does not.
    //
    // Mirrors the identical gate in startClone. It matters most HERE: the
    // templates site pre-fills `clone-of-<template>`, so every visitor cloning
    // the same template proposes the same name — rejecting that turned the
    // public funnel's happy path into a 409 for everyone after the first.
    if (
      config.deployment.defaultBackend === 'pages'
      && typeof body.name === 'string'
      && body.name.trim().length > 0
    ) {
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

    // 5. Park the configuration, encrypted, with a 60-minute TTL.
    const intent = await createCloneIntent(app.controlDb, {
      sourceAppId: source_app_id,
      destAppName: body.name,
      destRegion: body.dest_region,
      envVarValues: body.env_var_values,
      autoMintRequests: body.auto_mint_api_key,
      sourceIp: request.ip,
    });

    // 6. Return only the opaque id and expiry — never the secrets.
    return reply.send({
      intent_id: intent.id,
      expires_at: intent.expires_at.toISOString(),
    });
  });

  // POST /v1/clone-intents/:id/redeem
  //
  // The authenticated other half of the flow above: the visitor has now
  // registered, is back in the dashboard, and this turns their parked
  // configuration into a real clone job owned by their account.
  //
  // Ordering here is deliberate and two constraints pull against each other:
  //
  //   * A QUOTA_EXCEEDED or NAME_TAKEN failure must NOT consume the intent —
  //     the user upgrades their plan or picks a different name and retries the
  //     SAME intent id. So the claim cannot happen before startClone.
  //   * markIntentRedeemed is an atomic conditional claim (UPDATE ... WHERE
  //     redeemed_at IS NULL) returning a boolean, because two concurrent
  //     redemptions would otherwise both decrypt the same secrets and the
  //     second would silently overwrite the first's job id.
  //
  // So: startClone first, claim second, and only enqueue if the claim was won.
  // The loser of a race reports the WINNER's job id, never enqueues its own
  // duplicate, and disposes of that duplicate itself — marking it failed and
  // clearing its pending env vars. No background process would: the reaper
  // skips 'pending' rows and the pruner only deletes terminal ones.
  //
  // enqueueCloneTask writes to a regional runtime DB, so it runs last, on the
  // Pool, after the control-plane claim has committed.
  app.post('/v1/clone-intents/:id/redeem', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: string };
    const userId = requireUserId(request);

    const loaded = await loadRedeemableIntent(app.controlDb, id);
    if (!loaded.ok) {
      // Tested positively so TypeScript narrows to the member that carries
      // jobId — the other member's `reason` is itself a union, so a pair of
      // negative checks would not exclude it.
      if (loaded.reason === 'already_redeemed') {
        // Idempotent: hand back the job that the first redemption started.
        return reply.send({
          job_id: loaded.jobId,
          status: 'pending',
          already_redeemed: true,
        });
      }
      if (loaded.reason === 'not_found') {
        return reply.code(404).send(createAgentError({
          code: RESOURCE_NOT_FOUND,
          message: 'Clone session not found.',
          remediation: 'Start again from the template page.',
          documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
        }));
      }
      return reply.code(410).send({
        error: {
          code: 'CLONE_INTENT_EXPIRED',
          message: 'This clone session expired. Start again from the template.',
        },
      });
    }

    const { intent, envVarValues } = loaded;

    const destOrgId = request.auth?.organizationId
      ?? await resolveOrganizationId(app.controlDb, userId);

    // startClone owns every admission rule, including validating the
    // auto_mint_requests that the anonymous endpoint parked unvalidated.
    const result = await startClone({
      controlDb: app.controlDb,
      sourceAppId: intent.source_app_id,
      userId,
      destOrgId,
      name: body.name ?? intent.dest_app_name ?? undefined,
      destRegion: intent.dest_region ?? undefined,
      envVarValues,
      autoMintRequests: intent.auto_mint_requests ?? undefined,
      logger: request.log,
    });

    // Failure leaves the intent redeemable on purpose: the user fixes the
    // problem (upgrade, rename) and retries this same id.
    if (!result.ok) return sendStartCloneFailure(reply, result);

    const claimed = await markIntentRedeemed(app.controlDb, {
      id,
      userId,
      jobId: result.jobId,
    });

    if (!claimed) {
      // A concurrent redemption claimed the intent first. Our job row is a
      // duplicate: do not enqueue it, and do not report it as the result.
      const winner = await loadRedeemableIntent(app.controlDb, id);
      let winnerJobId: string | null = null;
      if (!winner.ok && winner.reason === 'already_redeemed') {
        winnerJobId = winner.jobId;
      }
      // Dispose of the duplicate here rather than leaving it for a background
      // job — no background job covers it. The reaper skips 'pending' rows and
      // the pruner only deletes terminal ones, so an un-enqueued job would sit
      // in 'pending' forever: burning a third of the user's in-flight clone cap
      // and holding their env var secrets in pending_env_vars indefinitely.
      // abandonDuplicateCloneJob marks it failed and NULLs those secrets in one
      // statement.
      //
      // The warn is emitted FIRST and the disposal is wrapped: if
      // abandonDuplicateCloneJob throws, losing the diagnostic as well as the
      // disposal would leave an undiagnosable orphan holding secrets. Log the
      // race, attempt the disposal, and log its failure separately — the
      // response to the user is the winner's job id either way.
      request.log.warn(
        { intentId: id, orphanedJobId: result.jobId, winnerJobId },
        '[clone-intent] lost redemption race; disposing of the duplicate clone job',
      );
      try {
        await abandonDuplicateCloneJob(
          app.controlDb,
          result.jobId,
          `Abandoned: a concurrent redemption of this clone session won the claim and started job ${winnerJobId ?? 'unknown'}. This duplicate was never queued.`,
        );
        request.log.warn(
          { intentId: id, orphanedJobId: result.jobId, winnerJobId },
          '[clone-intent] duplicate clone job marked failed and its pending env vars cleared',
        );
      } catch (err) {
        request.log.error(
          { err, intentId: id, orphanedJobId: result.jobId, winnerJobId },
          '[clone-intent] failed to dispose of the duplicate clone job; it still holds pending env vars',
        );
      }
      return reply.send({
        job_id: winnerJobId,
        status: 'pending',
        already_redeemed: true,
      });
    }

    // Regional runtime DB write — after the control-plane claim, never before.
    await enqueueCloneTask(result.sourceAppId, result.sourceRegion, result.jobId);

    return reply.send({
      job_id: result.jobId,
      status: 'pending',
      dest_region: result.destRegion,
      dest_app_id: result.destAppId,
      ...(result.redirectedFromRegion
        ? {
            dest_region_redirected_from: result.redirectedFromRegion,
            notice: `Region "${result.redirectedFromRegion}" is temporarily closed to new apps; this clone will be created in "${result.destRegion}" instead.`,
          }
        : {}),
    });
  });
}
