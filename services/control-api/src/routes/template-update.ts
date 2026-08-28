import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../utils/require-auth.js';
import { AppResolver } from '../services/app-resolver.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import {
  RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, RESOURCE_CONFLICT,
} from '@butterbase/shared/error-types';
import {
  computeDrift, computeDivergence, getLineage, type DriftResult, type Divergence,
} from '../services/app-lineage.js';
import { decideEligibility, type EligibilityReason, type EligibilityResult } from '../services/template-update-eligibility.js';
import { createUpdateJob, getActiveUpdateJob, getCloneJob } from '../services/clone-jobs.js';
import { getRelease } from '../services/template-releases.js';
import { logFromRequest } from '../services/audit/with-audit.js';

const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  ok: 'Eligible for update.',
  not_a_fork: 'This app is not a template fork.',
  severed: 'This fork has severed its template lineage; it can no longer receive updates.',
  current: 'This fork is already on the latest release.',
  modified:
    'This fork has been modified since it was cloned; the update was refused to avoid ' +
    'overwriting your changes.',
  unknown:
    "This fork's divergence from the template could not be determined (unknown); the " +
    'update was refused rather than guessing.',
};

/** Highest pending release, or null if the fork is not behind. `releases` is ordered DESC. */
function targetReleaseSummary(drift: DriftResult) {
  const r = drift.releases[0];
  if (!r) return null;
  return {
    release_number: r.release_number,
    label: r.label,
    notes: r.notes,
    published_at: r.published_at,
  };
}

/**
 * Divergence needs a live introspect (computeDivergence), so it's only computed
 * when drift already says the fork could plausibly be eligible — mirrors the
 * early-return order in decideEligibility itself.
 */
async function loadEligibility(
  app: FastifyInstance, forkId: string, dbName: string,
): Promise<{ drift: DriftResult; divergence: Divergence | null; decision: EligibilityResult }> {
  const drift = await computeDrift(app.controlDb, forkId);
  let divergence: Divergence | null = null;
  if (drift.is_fork && !drift.severed && drift.behind_by > 0) {
    const runtimePool = await getRuntimeDbForApp(app.controlDb, forkId);
    const appPool = await getAppPoolForApp(app.controlDb, forkId, dbName);
    divergence = await computeDivergence(app.controlDb, runtimePool, appPool, forkId);
  }
  const decision = decideEligibility(drift, divergence);
  return { drift, divergence, decision };
}

function notFound(message: string) {
  return createAgentError({
    code: RESOURCE_NOT_FOUND,
    message,
    remediation: 'Check the app id and job id.',
    documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
  });
}

function conflict(message: string, remediation: string) {
  return createAgentError({
    code: RESOURCE_CONFLICT,
    message,
    remediation,
    documentation_url: getDocUrl(RESOURCE_CONFLICT),
  });
}

function invalid(message: string, remediation: string) {
  return createAgentError({
    code: VALIDATION_INVALID_SCHEMA,
    message,
    remediation,
    documentation_url: getDocUrl(VALIDATION_INVALID_SCHEMA),
  });
}

export function templateUpdateRoutes(app: FastifyInstance): void {
  // GET /v1/:app_id/template/update/eligibility
  app.get('/v1/:app_id/template/update/eligibility', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );
    const { drift, decision } = await loadEligibility(app, resolved.id, resolved.db_name);
    return reply.send({
      eligible: decision.eligible,
      reason: decision.reason,
      target_release: targetReleaseSummary(drift),
    });
  });

  // POST /v1/:app_id/template/update
  app.post('/v1/:app_id/template/update', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const userId = requireUserId(request);
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, userId, request.auth?.organizationId ?? null,
    );

    // Check the in-flight mutex before paying for a live divergence introspect.
    const activeJob = await getActiveUpdateJob(app.controlDb, resolved.id);
    if (activeJob) {
      return reply.code(409).send(conflict(
        'An update is already in progress for this app.',
        `Check its status at GET /v1/${resolved.id}/template/update/${activeJob.id} before starting another.`,
      ));
    }

    const { drift, decision } = await loadEligibility(app, resolved.id, resolved.db_name);
    if (!decision.eligible) {
      return reply.code(422).send(invalid(
        ELIGIBILITY_MESSAGES[decision.reason],
        `Check GET /v1/${resolved.id}/template/update/eligibility for details.`,
      ));
    }

    const lineage = await getLineage(app.controlDb, resolved.id);
    const targetReleaseNumber = drift.releases[0]?.release_number;
    if (!lineage || !drift.source_app_id || targetReleaseNumber === undefined) {
      // decideEligibility only returns eligible:true when is_fork && behind_by > 0,
      // which guarantees a lineage row and a target release exist. Reaching here
      // means the two read paths disagree — refuse rather than create a job with
      // an unrecordable target.
      return reply.code(422).send(invalid(
        'This fork\'s lineage or target release could not be resolved.',
        'Retry; if this persists, check GET /v1/:app_id/template/status.',
      ));
    }

    const release = await getRelease(app.controlDb, drift.source_app_id, targetReleaseNumber);
    if (!release) {
      return reply.code(422).send(invalid(
        'The target release is no longer available.',
        'Retry; the template owner may have republished since eligibility was last checked.',
      ));
    }

    const job = await createUpdateJob(app.controlDb, {
      forkAppId: resolved.id,
      forkRegion: lineage.dest_region,
      sourceAppId: lineage.source_app_id,
      sourceRegion: lineage.source_region,
      targetReleaseId: release.id,
      sourceSnapshotId: release.snapshot_id,
      requestedByUserId: userId,
      // MUST stay null here — see createUpdateJob's doc comment. The worker
      // records the pre-sync snapshot itself, right before its first write.
      preSyncSnapshotId: null,
    });

    // neon_tasks is a per-region queue; the update task is enqueued in the
    // SOURCE app's region, same as clone.ts's enqueueCloneTask, and dispatched
    // to executeUpdate by the worker reading job.mode === 'update'.
    const sourcePool = getRuntimeDbPool(config.runtimeDb, lineage.source_region);
    await sourcePool.query(
      `INSERT INTO neon_tasks (app_id, task_type, task_meta) VALUES ($1, 'clone', $2)`,
      [lineage.source_app_id, JSON.stringify({ job_id: job.id })],
    );

    logFromRequest(request, {
      appId: resolved.id,
      category: 'admin',
      eventType: 'app.template.update',
      action: 'create',
      resourceType: 'app_config',
      resourceId: job.id,
      eventData: { target_release_id: release.id, target_release_number: release.release_number },
      success: true,
    });

    return reply.code(202).send({
      job_id: job.id,
      status: job.status,
      mode: 'update',
      target_release_number: release.release_number,
    });
  });

  // GET /v1/:app_id/template/update/:job_id
  app.get('/v1/:app_id/template/update/:job_id', async (request, reply) => {
    const { app_id, job_id } = request.params as { app_id: string; job_id: string };
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );
    const job = await getCloneJob(app.controlDb, job_id);
    if (!job || job.mode !== 'update' || job.dest_app_id !== resolved.id) {
      return reply.code(404).send(notFound('Update job not found.'));
    }
    return reply.send({
      job_id: job.id,
      status: job.status,
      mode: job.mode,
      target_release_id: job.target_release_id,
      pre_sync_snapshot_id: job.pre_sync_snapshot_id,
      error_message: job.error_message,
      warnings: (job.warnings ?? []) as string[],
      created_at: job.created_at.toISOString(),
      completed_at: job.completed_at?.toISOString() ?? null,
    });
  });

  // POST /v1/:app_id/template/update/:job_id/undo
  //
  // Restores code only — sets repo_latest_snapshot back to the pre-sync
  // snapshot the worker recorded before its first write. Issues no DDL:
  // schema is forward-only by design, so a rolled-back fork keeps whatever
  // columns/tables the update (additively) introduced.
  app.post('/v1/:app_id/template/update/:job_id/undo', async (request, reply) => {
    const { app_id, job_id } = request.params as { app_id: string; job_id: string };
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null,
    );
    const job = await getCloneJob(app.controlDb, job_id);
    if (!job || job.mode !== 'update' || job.dest_app_id !== resolved.id) {
      return reply.code(404).send(notFound('Update job not found.'));
    }
    if (job.status !== 'completed') {
      return reply.code(409).send(conflict(
        'Only a completed update can be undone.',
        'Wait for the update to finish, or check its status first.',
      ));
    }
    if (!job.pre_sync_snapshot_id) {
      return reply.code(422).send(invalid(
        'This update recorded no pre-sync snapshot, so it cannot be undone.',
        'This job predates pre-sync capture, or is a clone-mode job; there is nothing to restore.',
      ));
    }

    const runtimePool = await getRuntimeDbForApp(app.controlDb, resolved.id);
    await runtimePool.query(
      `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
      [job.pre_sync_snapshot_id, resolved.id],
    );

    logFromRequest(request, {
      appId: resolved.id,
      category: 'admin',
      eventType: 'app.template.update.undo',
      action: 'update',
      resourceType: 'app_config',
      resourceId: job.id,
      eventData: { restored_snapshot_id: job.pre_sync_snapshot_id },
      success: true,
    });

    return reply.send({ restored_snapshot_id: job.pre_sync_snapshot_id, schema_unchanged: true });
  });
}
