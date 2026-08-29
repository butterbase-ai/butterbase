import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../utils/require-auth.js';
import { AppResolver } from '../services/app-resolver.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { config } from '../config.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
import {
  RESOURCE_NOT_FOUND, VALIDATION_INVALID_SCHEMA, RESOURCE_CONFLICT, EXTERNAL_DB_ERROR,
} from '@butterbase/shared/error-types';
import {
  computeDrift, computeDivergence, getLineage, type DriftResult, type Divergence,
} from '../services/app-lineage.js';
import { decideEligibility, type EligibilityReason, type EligibilityResult } from '../services/template-update-eligibility.js';
import { createUpdateJob, deleteCloneJob, getActiveUpdateJob, getCloneJob, UpdateJobConflictError} from '../services/clone-jobs.js';
import { getRelease } from '../services/template-releases.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import {
  canUndoUpdateJob, restoreFunctionsFromManifest, restoreLineage,
  templateFunctionNamesForRelease,
} from '../services/template-update-undo.js';
import { setLatest } from '../services/repo-storage.js';

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

function unavailable(message: string, remediation: string) {
  return createAgentError({
    code: EXTERNAL_DB_ERROR,
    message,
    remediation,
    documentation_url: getDocUrl(EXTERNAL_DB_ERROR),
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

    let job;
    try {
      job = await createUpdateJob(app.controlDb, {
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
    } catch (err) {
      // The getActiveUpdateJob pre-check above is a read-then-write; two
      // concurrent requests can both clear it. The partial unique index is what
      // actually holds the line, and losing that race is the SAME condition the
      // pre-check reports — so answer it identically instead of leaking a 500.
      if (err instanceof UpdateJobConflictError) {
        return reply.code(409).send(conflict(
          'An update is already in progress for this app.',
          `Check its status at GET /v1/${resolved.id}/template/update before starting another.`,
        ));
      }
      throw err;
    }

    // neon_tasks is a per-region queue; the update task is enqueued in the
    // SOURCE app's region, same as clone.ts's enqueueCloneTask, and dispatched
    // to executeUpdate by the worker reading job.mode === 'update'.
    //
    // The job row and its task live on different planes, so they cannot share a
    // transaction — compensate instead. An enqueued-less 'pending' job is not a
    // harmless orphan: getActiveUpdateJob counts it as in flight, so it would
    // 409 EVERY future update of this fork, forever, with no worker ever coming
    // to move it out of 'pending'. Deleting it is safe precisely because nothing
    // has run: the row is untouched since creation and no other write references it.
    const sourcePool = getRuntimeDbPool(config.runtimeDb, lineage.source_region);
    try {
      await sourcePool.query(
        `INSERT INTO neon_tasks (app_id, task_type, task_meta) VALUES ($1, 'clone', $2)`,
        [lineage.source_app_id, JSON.stringify({ job_id: job.id })],
      );
    } catch (err) {
      await deleteCloneJob(app.controlDb, job.id).catch((delErr) => {
        request.log.error(
          { delErr, jobId: job.id, appId: resolved.id },
          '[update] enqueue failed AND job cleanup failed; fork will be stuck on a phantom pending job',
        );
      });
      request.log.error({ err, jobId: job.id, appId: resolved.id }, '[update] enqueue failed; job rolled back');
      return reply.code(503).send(unavailable(
        'The update could not be queued.',
        'Retry in a moment. Nothing was changed.',
      ));
    }

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
  // Restores CODE and LINEAGE; issues no DDL. Schema is forward-only by
  // design, so a rolled-back fork keeps whatever columns/tables the update
  // (additively) introduced.
  //
  // The lineage half is not cosmetic. executeUpdate's last step advances
  // app_lineage.base_snapshot_id to the new snapshot, and computeDivergence is
  // exactly `apps.repo_latest_snapshot !== app_lineage.base_snapshot_id`. An
  // undo that moved only the repo pointer therefore left the fork reading
  // repo: true -> decideEligibility 'modified' -> permanently ineligible for
  // any future update and displayed to its owner as "You have changed this
  // app", recoverable only by hand-editing app_lineage. Undo was a one-way
  // trap; restoring lineage is what makes it an actual escape.
  //
  // Order matters: functions, then repo, then lineage. Lineage is the write
  // that declares "this fork is unmodified again", so it lands last, only
  // after the state it describes has actually been put back. Two planes are
  // involved (runtime + control), so this cannot be one transaction; ordering
  // is the guarantee instead, and every intermediate state is one the eligibility
  // gate reads as ineligible rather than as falsely-clean.
  app.post('/v1/:app_id/template/update/:job_id/undo', async (request, reply) => {
    const { app_id, job_id } = request.params as { app_id: string; job_id: string };
    const userId = requireUserId(request);
    const resolved = await AppResolver.resolveApp(
      app.controlDb, app_id, userId, request.auth?.organizationId ?? null,
    );
    const job = await getCloneJob(app.controlDb, job_id);
    if (!job || job.mode !== 'update' || job.dest_app_id !== resolved.id) {
      return reply.code(404).send(notFound('Update job not found.'));
    }

    const gate = canUndoUpdateJob(job);
    if (!gate.allowed) {
      if (gate.reason === 'not_terminal') {
        return reply.code(409).send(conflict(
          'Only a finished update can be undone.',
          'Wait for the update to finish or fail, then try again.',
        ));
      }
      return reply.code(422).send(invalid(
        'This update recorded no pre-sync state, so it cannot be undone.',
        'The update was refused before it wrote anything, or the job predates pre-sync capture; ' +
          'there is nothing to restore.',
      ));
    }

    const pre = job.pre_sync_lineage;
    const restoredSnapshotId = job.pre_sync_snapshot_id ?? pre?.base_snapshot_id ?? null;
    const runtimePool = await getRuntimeDbForApp(app.controlDb, resolved.id);
    const warnings: string[] = [];
    let functionsRestored = 0;
    let functionsRemoved = 0;

    // 1. Function bodies. Spec §8 promises undo restores code, and the update
    //    overwrites function bodies as well as the repo — a repo-only undo left
    //    the template's function bodies running against the fork's old repo,
    //    which is worse than no undo at all.
    if (pre?.manifest) {
      const templateFns = await templateFunctionNamesForRelease(app.controlDb, job.target_release_id);
      const fnResult = await restoreFunctionsFromManifest(
        runtimePool, resolved.id, pre.manifest, templateFns, userId, request.log,
      );
      functionsRestored = fnResult.restored;
      functionsRemoved = fnResult.removed;
      warnings.push(...fnResult.warnings);
    } else {
      warnings.push(
        'No pre-update manifest was recorded for this job, so function bodies were not restored — ' +
          'only the repo pointer and lineage.',
      );
    }

    // 2. Repo pointer, both places the update wrote it: the S3 "latest" object
    //    and the runtime apps row. Leaving the S3 pointer on the new snapshot
    //    would make the two disagree about what HEAD is.
    if (restoredSnapshotId) {
      await setLatest(resolved.id, restoredSnapshotId);
      await runtimePool.query(
        `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
        [restoredSnapshotId, resolved.id],
      );
    }

    // 3. Lineage last. See the ordering note above.
    let lineageRestored = false;
    if (pre) {
      await restoreLineage(app.controlDb, resolved.id, pre);
      lineageRestored = true;
    } else {
      warnings.push(
        'No pre-update lineage was recorded for this job, so this app may still report as modified. ' +
          'Contact support to have its lineage repaired.',
      );
    }

    logFromRequest(request, {
      appId: resolved.id,
      category: 'admin',
      eventType: 'app.template.update.undo',
      action: 'update',
      resourceType: 'app_config',
      resourceId: job.id,
      eventData: {
        restored_snapshot_id: restoredSnapshotId,
        lineage_restored: lineageRestored,
        functions_restored: functionsRestored,
        functions_removed: functionsRemoved,
        undone_from_status: job.status,
      },
      success: true,
    });

    return reply.send({
      restored_snapshot_id: restoredSnapshotId,
      lineage_restored: lineageRestored,
      functions_restored: functionsRestored,
      functions_removed: functionsRemoved,
      schema_unchanged: true,
      warnings,
    });
  });
}
