/**
 * Admission rules for "may this app get a staging environment".
 *
 * Mirrors start-clone.ts: never touches `reply`, returns a result the route
 * maps to HTTP via sendStartStagingFailure. Staging creation is a clone with
 * three extra rules — no staging of a staging, one staging per app, and the
 * destination region is pinned to the production app's region because
 * app_environments lives in a regional runtime DB.
 *
 * The staging subdomain is obtained via allocateStagingSubdomain, not by
 * deriving it directly with deriveStagingName: apps.subdomain carries a
 * global unique index (idx_apps_subdomain), so an unrelated app may already
 * hold "<name>-staging". allocateStagingSubdomain checks for that collision
 * and falls back to "-2", "-3", etc.
 */
import type pg from 'pg';
import type { FastifyReply } from 'fastify';
import { getEnvironmentLink, getLinkByStagingApp } from './app-environments.js';
import { startClone, type StartCloneFailure } from './start-clone.js';
import { setCloneJobStatus } from './clone-jobs.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { deriveStagingName, allocateStagingSubdomain } from './staging-naming.js';
import { getProvisionAllowedRegions } from './provision-region.js';
import { createAgentError, getDocUrl } from './error-handler.js';
import { VALIDATION_INVALID_SCHEMA, RESOURCE_NOT_FOUND } from '@butterbase/shared/error-types';

export type StartStagingFailure =
  | { code: 'ALREADY_EXISTS'; stagingAppId: string }
  | { code: 'IS_STAGING' }
  | { code: 'PROD_NOT_FOUND' }
  | { code: 'NO_SUBDOMAIN'; name: string }
  | { code: 'REGION_CLOSED'; region: string }
  | { code: 'CLONE_REFUSED'; inner: StartCloneFailure };

export interface StartStagingSuccess {
  ok: true;
  jobId: string;
  stagingName: string;
  stagingSubdomain: string;
  region: string;
}

export type StartStagingResult = StartStagingSuccess | ({ ok: false } & StartStagingFailure);

export async function startStaging(args: {
  controlDb: pg.Pool;
  prodAppId: string;
  userId: string;
  orgId: string;
  logger: { warn(obj: unknown, msg?: string): void };
}): Promise<StartStagingResult> {
  const { controlDb, prodAppId, userId, orgId, logger } = args;

  const runtimeDb = await getRuntimeDbForApp(controlDb, prodAppId);

  const appRow = await runtimeDb.query<{ name: string; region: string; subdomain: string | null }>(
    `SELECT name, region, subdomain FROM apps WHERE id = $1`, [prodAppId],
  );
  if (appRow.rows.length === 0) return { ok: false, code: 'PROD_NOT_FOUND' };
  const region = appRow.rows[0].region;

  // A staging app must not itself sprout a staging app: the link table would
  // need a chain and promote would have no unambiguous production target.
  if (await getLinkByStagingApp(runtimeDb, prodAppId)) return { ok: false, code: 'IS_STAGING' };

  const existing = await getEnvironmentLink(runtimeDb, prodAppId);
  if (existing) {
    return { ok: false, code: 'ALREADY_EXISTS', stagingAppId: existing.staging_app_id };
  }

  const prod = appRow.rows[0];
  const stagingName = deriveStagingName(prod.name);

  // subdomain is nullable; fall back to the name when unset.
  const prodSubdomain = prod.subdomain ?? prod.name;

  let stagingSubdomain: string;
  try {
    stagingSubdomain = await allocateStagingSubdomain(runtimeDb, prodSubdomain);
  } catch {
    return { ok: false, code: 'NO_SUBDOMAIN', name: prod.name };
  }

  // Pre-check, before any write: startClone unconditionally runs
  // resolveProvisionRegion and will silently redirect to an open region if the
  // production app's home region has been closed via
  // BUTTERBASE_PROVISION_ALLOWED_REGIONS. app_environments lives in a regional
  // runtime DB and both its foreign keys must resolve locally, so a redirect
  // would produce a link row that can never be written. Reject up front — no
  // job row, no side effects — rather than let startClone create one first.
  const provisionAllowed = getProvisionAllowedRegions();
  if (provisionAllowed.length > 0 && !provisionAllowed.includes(region)) {
    return { ok: false, code: 'REGION_CLOSED', region };
  }

  // destRegion is pinned, not defaulted: app_environments FKs are local to one
  // regional runtime DB, so a redirected region would make the link unwritable.
  const clone = await startClone({
    controlDb,
    sourceAppId: prodAppId,
    userId,
    destOrgId: orgId,
    name: stagingName,
    destRegion: region,
    logger,
    // A staging environment's source is the caller's own production app,
    // which is (correctly, normally) private and may have no repo/frontend
    // snapshot at all. Those two checks exist for the public-template-clone
    // flow, not this one — see start-clone.ts's doc comment on the option.
    skipVisibilityAndSnapshotChecks: true,
  });
  if (!clone.ok) return { ok: false, code: 'CLONE_REFUSED', inner: clone };

  // Defensive post-check: this should be unreachable given the pre-check
  // above, since the same getProvisionAllowedRegions() list gates both. It
  // exists as a guard against a future change to startClone's redirect
  // behaviour (e.g. a second allow-list, a race where the env var changes
  // between the two calls) silently reintroducing the cross-region link. If
  // it ever fires, the job it guards against has already been INSERTed by
  // startClone, so it must be marked failed here rather than left pending —
  // otherwise the neon task worker would pick it up and actually provision
  // the cross-region staging app.
  if (clone.destRegion !== region || clone.redirectedFromRegion) {
    await setCloneJobStatus(controlDb, clone.jobId, {
      status: 'failed',
      error_message: `Staging clone redirected from ${region} to ${clone.destRegion}; refusing a cross-region app_environments link.`,
    });
    return { ok: false, code: 'REGION_CLOSED', region };
  }

  await controlDb.query(
    `UPDATE template_clone_jobs SET mode = 'staging_create' WHERE id = $1`, [clone.jobId],
  );

  return { ok: true, jobId: clone.jobId, stagingName, stagingSubdomain, region: clone.destRegion };
}

/**
 * Map a `startStaging` failure onto an HTTP response. Lives beside the
 * failure union on purpose: adding a code to `StartStagingFailure` without
 * adding a mapping here is a compile-time gap, not a runtime surprise in
 * whichever route forgot it.
 */
export function sendStartStagingFailure(
  reply: FastifyReply, result: { ok: false } & StartStagingFailure,
): FastifyReply {
  switch (result.code) {
    case 'ALREADY_EXISTS':
      return reply.code(409).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `This app already has a staging environment (${result.stagingAppId}).`,
        remediation: 'Reset the existing staging environment instead of creating a second one.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'IS_STAGING':
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: 'This app is itself a staging environment.',
        remediation: 'Create the staging environment from the production app instead.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'PROD_NOT_FOUND':
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'App not found.',
        remediation: 'Check the app id.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    case 'NO_SUBDOMAIN':
      return reply.code(409).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Could not allocate a staging subdomain for "${result.name}": the staging subdomain space is exhausted.`,
        remediation: 'Free up an existing "<name>-staging"-style subdomain, or rename the production app, then retry.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'REGION_CLOSED':
      return reply.code(409).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Region "${result.region}" is closed to new apps, so a staging environment cannot be created there.`,
        remediation: 'Wait until the region reopens, or ask an operator to add it to BUTTERBASE_PROVISION_ALLOWED_REGIONS.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    case 'CLONE_REFUSED':
      return reply.code(400).send(createAgentError({
        code: VALIDATION_INVALID_SCHEMA,
        message: `Cannot create a staging environment: ${result.inner.code}.`,
        remediation: 'Resolve the underlying clone restriction, then retry.',
        documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
      }));
    default: {
      // Adding a StartStagingFailure code without a case above fails to
      // compile here, and the error names the unmapped code.
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
