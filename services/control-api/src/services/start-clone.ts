/**
 * The one place that decides whether a clone may start.
 *
 * Extracted from `POST /v1/templates/:source_app_id/clone` so that a second
 * entry point (anonymous clone-intent redemption after registration) can reuse
 * the identical validation instead of forking it. Every rule that used to live
 * in that handler lives here now: the global app-name collision check, the
 * per-user in-flight cap, the two payload shape validators, region resolution
 * with the closed-region redirect, and the project quota.
 *
 * `startClone` never touches `reply` — it returns a result and the routes do
 * the HTTP mapping via `sendStartCloneFailure` below, which is co-located with
 * the `StartCloneFailure` union so a new failure code cannot silently ship
 * without a mapping.
 *
 * It deliberately does NOT enqueue the neon task. That write targets a regional
 * runtime DB and must happen only after the control-plane work has committed,
 * so it stays the caller's responsibility.
 */

import type pg from 'pg';
import type { FastifyReply } from 'fastify';
import { createCloneJob } from './clone-jobs.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { AppNotFoundError } from './app-resolver.js';
import { checkProjectQuota } from './project-quota.js';
import { getProvisionAllowedRegions, resolveProvisionRegion } from './provision-region.js';
import { createAgentError, getDocUrl } from './error-handler.js';
import { quotaErrors } from '../utils/quota-errors.js';
import { validateEnvVarValues, validateAutoMintRequests } from './clone-validation.js';
import {
  VALIDATION_INVALID_SCHEMA,
  RESOURCE_NOT_FOUND,
} from '@butterbase/shared/error-types';

export type StartCloneFailure =
  // Both reasons produce the identical 404 status, error code and message —
  // the response deliberately does not reveal whether a non-public app exists.
  // `reason` only selects the remediation hint, which differed before the
  // extraction and must keep differing: pointing an unknown-app caller at
  // "only public apps are clonable" sends them after the wrong problem.
  | { code: 'SOURCE_NOT_FOUND'; reason: 'unknown_app' | 'not_public' }
  | { code: 'NO_SNAPSHOT' }
  | { code: 'NAME_TAKEN'; name: string }
  | { code: 'INFLIGHT_LIMIT' }
  | { code: 'INVALID_ENV_SHAPE'; message: string }
  | { code: 'INVALID_AUTO_MINT'; message: string }
  | { code: 'QUOTA_EXCEEDED'; current: number; limit: number };

export interface StartCloneSuccess {
  ok: true;
  jobId: string;
  destAppId: string | null;
  sourceAppId: string;
  sourceRegion: string;
  destRegion: string;
  redirectedFromRegion?: string;
}

export type StartCloneResult = StartCloneSuccess | ({ ok: false } & StartCloneFailure);

export async function startClone(args: {
  controlDb: pg.Pool;
  sourceAppId: string;
  userId: string;
  destOrgId: string;
  name?: string;
  destRegion?: string;
  envVarValues?: Record<string, Record<string, string>>;
  autoMintRequests?: { fn_name: string; key: string }[];
  logger: { warn(obj: unknown, msg?: string): void };
}): Promise<StartCloneResult> {
  const { controlDb, sourceAppId, userId, destOrgId, logger } = args;

  // Enforce project limit against the destination org's plan. Blocks up-front
  // so a queued clone can't silently push the org over max_projects.
  const quota = await checkProjectQuota(controlDb, destOrgId);
  if (!quota.ok) {
    return { ok: false, code: 'QUOTA_EXCEEDED', current: quota.current, limit: quota.limit };
  }

  // getRuntimeDbForApp throws AppNotFoundError if the app isn't in
  // org_app_index. We translate to the same generic not-found we use for the
  // non-public case below, to avoid leaking existence information.
  let sourcePool;
  try {
    sourcePool = await getRuntimeDbForApp(controlDb, sourceAppId);
  } catch (err) {
    if (err instanceof AppNotFoundError) {
      return { ok: false, code: 'SOURCE_NOT_FOUND', reason: 'unknown_app' };
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
    [sourceAppId],
  );
  const src = srcRow.rows[0];
  if (!src || src.visibility !== 'public') {
    return { ok: false, code: 'SOURCE_NOT_FOUND', reason: 'not_public' };
  }
  if (!src.repo_latest_snapshot) {
    return { ok: false, code: 'NO_SNAPSHOT' };
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
  if (typeof args.name === 'string' && args.name.trim().length > 0) {
    const requestedName = args.name.trim();
    const collision = await controlDb.query<{ app_id: string }>(
      `SELECT app_id FROM org_app_index WHERE app_name = $1 LIMIT 1`,
      [requestedName],
    );
    if (collision.rows.length > 0) {
      return { ok: false, code: 'NAME_TAKEN', name: requestedName };
    }
  }

  // Cap simultaneous non-terminal clone jobs per user at 3.
  // template_clone_jobs also holds template-update rows (mode = 'update');
  // scope to mode = 'clone' so in-flight updates don't eat into this quota.
  const inflightResult = await controlDb.query<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM template_clone_jobs
      WHERE requested_by_user_id = $1
        AND mode = 'clone'
        AND status NOT IN ('completed', 'failed')`,
    [userId],
  );
  if (inflightResult.rows[0].c >= 3) {
    return { ok: false, code: 'INFLIGHT_LIMIT' };
  }

  // Validate env_var_values / auto_mint_api_key shape. Extracted into pure
  // validators below so the anonymous clone-intent route can apply the exact
  // same rules without going through the authenticated-only work above
  // (quota check, in-flight cap) that requires a userId/destOrgId it doesn't
  // have.
  const envShape = validateEnvVarValues(args.envVarValues);
  if (!envShape.ok) {
    return { ok: false, code: 'INVALID_ENV_SHAPE', message: envShape.message };
  }

  const autoMintShape = validateAutoMintRequests(args.autoMintRequests);
  if (!autoMintShape.ok) {
    return { ok: false, code: 'INVALID_AUTO_MINT', message: autoMintShape.message };
  }

  // Accept dest_region (preferred) or the legacy region alias — the caller has
  // already collapsed those two into `destRegion`. When neither is provided,
  // fall back to the operator-configured default before the source region —
  // the source may be at capacity while the default has headroom (Neon's
  // 500-databases-per-branch limit).
  const requestedDestRegion =
    args.destRegion ??
    process.env.BUTTERBASE_DEFAULT_REGION ??
    src.region;

  // If the caller pinned a region temporarily closed to new apps (e.g. the
  // dashboard clone form defaulting to source.region), redirect to the first
  // open region rather than 400ing — see services/provision-region.ts. The
  // redirect is reported on the job response so the clone never lands in a
  // different region without the caller being told.
  const provisionAllowed = getProvisionAllowedRegions();
  const placement = resolveProvisionRegion(requestedDestRegion, provisionAllowed);
  const destRegion = placement.region;
  if (placement.redirected) {
    logger.warn(
      { requestedDestRegion, destRegion, sourceRegion: src.region, allowed: provisionAllowed },
      '[clone] redirecting new clone to open region',
    );
  }

  const job = await createCloneJob(controlDb, {
    sourceAppId,
    sourceSnapshotId: src.repo_latest_snapshot,
    sourceRegion: src.region,
    destRegion,
    requestedByUserId: userId,
    destOrganizationId: destOrgId,
    destAppName: args.name,
    pendingEnvVarValues: args.envVarValues,
    autoMintRequests: args.autoMintRequests,
  });

  return {
    ok: true,
    jobId: job.id,
    destAppId: job.dest_app_id ?? null,
    sourceAppId,
    sourceRegion: src.region,
    destRegion,
    ...(placement.redirected ? { redirectedFromRegion: placement.requestedRegion } : {}),
  };
}

/**
 * Map a `startClone` failure onto the HTTP response the clone route sent before
 * the extraction. Lives beside the failure union on purpose: adding a code to
 * `StartCloneFailure` without adding a mapping here is a compile-time gap, not
 * a runtime surprise in whichever route forgot it.
 */
export function sendStartCloneFailure(
  reply: FastifyReply,
  failure: { ok: false } & StartCloneFailure,
): FastifyReply {
  switch (failure.code) {
    case 'SOURCE_NOT_FOUND':
      // Same status/code/message either way — only the hint differs, exactly as
      // it did in the pre-extraction handler.
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'Source app not found or not public.',
        remediation: failure.reason === 'unknown_app'
          ? 'Verify the app id and that the source app has visibility=public.'
          : 'Only public apps are clonable.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    case 'NO_SNAPSHOT':
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'Source app has no repo snapshot yet.',
        remediation: 'The source must run `butterbase repo push` at least once before it can be cloned.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'NAME_TAKEN':
      return reply.code(409).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `The app name "${failure.name}" is already taken.`,
        remediation: 'Pick a different name.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'INFLIGHT_LIMIT':
      return reply.code(429).send({
        error: {
          code: 'CLONE_LIMIT_INFLIGHT',
          message: 'You already have 3 clones in progress. Wait for one to complete or fail.',
        },
      });
    case 'INVALID_ENV_SHAPE':
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: failure.message,
        remediation: 'Send env_var_values as { fn_name: { KEY: "value" } }.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'INVALID_AUTO_MINT':
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: failure.message,
        remediation: 'Send auto_mint_api_key as [{ fn_name: "fn", key: "BUTTERBASE_API_KEY" }].',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'QUOTA_EXCEEDED':
      return reply.code(403).send(quotaErrors.projectLimitReached(failure.current, failure.limit));
    default: {
      // Adding a StartCloneFailure code without a case above fails to compile
      // here, and the error names the unmapped code. Without this the switch
      // would infer `FastifyReply | undefined` (tsconfig sets `strict` but not
      // `noImplicitReturns`), and a route returning that would resolve its
      // handler without ever calling send — a hung request, not a wrong status.
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}
