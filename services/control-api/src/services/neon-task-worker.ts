import pg from 'pg';
import * as Sentry from '@sentry/node';
import { config, assertRegionConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { provisionNeonDbForApp } from './app-db-provision.js';
import { teardownAppDb } from './app-db-teardown.js';
import { runMigrationsWithRetry, generateAppId, insertAppRow, provisionAppBackground } from './provisioner.js';
import { runDataPlaneMigrations } from './migrator.js';
import { notifyProvisioningFailed, notifyCloneFailed } from './failure-notifications.service.js';
import { addOrgAppIndex, removeOrgAppIndex } from './org-app-index.js';
import { resolveOrganizationId } from './org-resolver.js';
import { getCloneJob, setCloneJobStatus, appendCloneJobWarnings, isTerminalCloneStatus } from './clone-jobs.js';
import {
  getManifestJson,
  putManifest,
  setLatest,
  copyBlobSameRegion,
  copyBlobCrossRegion,
  copyManifestSameRegion,
  getBlobBuffer,
  putBlobBuffer,
} from './repo-storage.js';
import { validateManifest } from './repo-manifest.js';
import { filterAdditive } from './schema-additive-filter.js';
import { decideEligibility } from './template-update-eligibility.js';
import { rewriteManifestEntries, type RepoManifestEntry } from './template-update-repo.js';
import { S3Client } from '@aws-sdk/client-s3';
import { getAppPoolForApp } from './app-pool.js';
import { replaySchema, replayRls, replaySeedData, replayFunctions, replayNonSecretConfig, replayMeetingsWebhook, replayAuthHookBinding, replaySubstrateLink, replayFrontend } from './clone-replay.js';
import { replayDurableObjectsForClone, listDoEnvVarKeys } from './durable-objects.service.js';
import { AUTO_MINT_CONVENTION_KEYS, mintApiKeyForClone } from './clone-env-vars.js';
import { replayAppEnvVars } from './clone-app-env.js';
import { decrypt } from './crypto.js';
import { insertCloneAuditLog } from './audit/audit-events-service.js';
import { enqueueWebhookDelivery } from './clone-webhook-store.js';
import { getCloneAppOverrides, resolveOverridesForClone } from './clone-app-overrides.js';
import {
  recordLineage,
  computeDrift,
  computeDivergence,
  type Divergence,
  type DriftResult,
} from './app-lineage.js';
import { captureAppState } from './app-state-capture.js';
import { listReleases } from './template-releases.js';

interface NeonTask {
  id: number;
  app_id: string;
  task_type: 'provision' | 'deprovision' | 'clone';
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_at: Date | null;
  run_after: Date;
  created_at: Date;
  task_meta: { job_id?: string } | null;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const POLL_INTERVAL_MS = 1000;
const STALE_THRESHOLD_MINUTES = 5;
const BACKOFF_SECONDS = [2, 4, 8, 16, 32];

/**
 * Starts the Neon task queue worker. Returns the interval handle for cleanup.
 */
export function startNeonTaskWorker(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  logger: Logger,
): NodeJS.Timeout {
  // Force eager parse so a malformed CLONE_APP_ENV_OVERRIDES blob fails the
  // worker at startup, not mid-clone.
  getCloneAppOverrides();

  let running = false;

  const interval = setInterval(async () => {
    // Prevent overlapping ticks if a task takes longer than the poll interval
    if (running) return;
    running = true;

    try {
      await recoverStaleTasks(controlDb, logger);
      await processNextTask(controlDb, dataPlaneDb, logger);
    } catch (err) {
      logger.error({ err }, '[neon-task-worker] Unexpected error in poll loop');
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);

  logger.info('[neon-task-worker] Started (poll every 1s)');
  return interval;
}

/**
 * Reset tasks stuck in 'processing' (crashed worker) back to pending,
 * or mark them failed if they've exhausted retries.
 */
async function recoverStaleTasks(controlDb: pg.Pool, logger: Logger): Promise<void> {
  // neon_tasks is a runtime-tier table (per-region queue)
  const runtimePool = getRuntimeDbPool(config.runtimeDb, assertRegionConfig().instanceRegion);

  // Reset retriable stale tasks
  const reset = await runtimePool.query(
    `UPDATE neon_tasks
     SET status = 'pending', locked_at = NULL, run_after = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '${STALE_THRESHOLD_MINUTES} minutes'
       AND attempts < max_attempts
     RETURNING id, app_id, task_type, attempts`,
  );

  if (reset.rowCount && reset.rowCount > 0) {
    logger.warn({ count: reset.rowCount, tasks: reset.rows }, '[neon-task-worker] Recovered stale tasks');
  }

  // Permanently fail exhausted stale tasks
  const failed = await runtimePool.query<{ id: number; app_id: string; task_type: string }>(
    `UPDATE neon_tasks
     SET status = 'failed',
         last_error = 'Stale: worker crashed or timed out',
         completed_at = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '${STALE_THRESHOLD_MINUTES} minutes'
       AND attempts >= max_attempts
     RETURNING id, app_id, task_type`,
  );

  for (const task of failed.rows) {
    logger.error({ task }, '[neon-task-worker] Task permanently failed (stale recovery)');
    if (task.task_type === 'provision') {
      // apps row lives in the app's home region — may differ from this
      // worker's queue region. Look it up before updating.
      const appPool = await getRuntimeDbForApp(controlDb, task.app_id).catch(() => null);
      if (appPool) {
        await appPool.query(
          `UPDATE apps SET provisioning_status = 'failed', provisioning_error = 'Max attempts exceeded (worker crashed)', updated_at = now() WHERE id = $1`,
          [task.app_id],
        ).catch(() => {});
        notifyProvisioningFailed(controlDb, appPool, { appId: task.app_id, provisioningError: 'Max attempts exceeded (worker crashed)' }).catch(() => {});
      }
    }
  }
}

/**
 * Atomically claim the next pending task and execute it.
 */
async function processNextTask(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  logger: Logger,
): Promise<void> {
  // neon_tasks is a runtime-tier table (per-region queue)
  const runtimePool = getRuntimeDbPool(config.runtimeDb, assertRegionConfig().instanceRegion);

  // Atomic claim: pick oldest runnable task
  const result = await runtimePool.query<NeonTask>(
    `UPDATE neon_tasks
     SET status = 'processing', locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM neon_tasks
       WHERE status = 'pending' AND run_after <= now()
       ORDER BY run_after ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );

  if (result.rows.length === 0) return; // Queue empty

  const task = result.rows[0];
  const start = Date.now();
  logger.info({ taskId: task.id, type: task.task_type, appId: task.app_id, attempt: task.attempts }, '[neon-task-worker] Claimed task');

  try {
    if (task.task_type === 'provision') {
      await executeProvision(controlDb, dataPlaneDb, task, logger);
    } else if (task.task_type === 'deprovision') {
      await executeDeprovision(controlDb, dataPlaneDb, task, logger);
    } else if (task.task_type === 'clone') {
      // One task_type covers both directions of the template pipeline. The job
      // row's `mode` is what distinguishes "make me a new fork" from "reset this
      // existing fork's code to the latest release"; they share nothing but the
      // queue. A missing/absent job falls through to executeClone, which raises
      // the precise error for that case.
      const cloneJobId = task.task_meta?.job_id;
      const queuedJob = cloneJobId ? await getCloneJob(controlDb, cloneJobId) : null;
      if (resolveCloneDispatch(queuedJob) === 'update') {
        await executeUpdate(controlDb, task, logger);
      } else {
        await executeClone(controlDb, dataPlaneDb, task, logger);
      }
    } else {
      throw new Error(`Unknown task_type: ${task.task_type}`);
    }

    // Mark completed
    await runtimePool.query(
      `UPDATE neon_tasks SET status = 'completed', completed_at = now() WHERE id = $1`,
      [task.id],
    );

    logger.info({ taskId: task.id, durationMs: Date.now() - start }, '[neon-task-worker] Task completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId: task.id, attempt: task.attempts, maxAttempts: task.max_attempts, error: msg }, '[neon-task-worker] Task failed');

    if (task.attempts >= task.max_attempts) {
      // Permanently failed
      await runtimePool.query(
        `UPDATE neon_tasks SET status = 'failed', last_error = $1, completed_at = now() WHERE id = $2`,
        [msg.slice(0, 1000), task.id],
      );

      if (task.task_type === 'provision') {
        const genericError = msg.includes('Neon API error') || msg.includes('NeonDb')
          ? 'Database failed to provision due to an internal infrastructure error.'
          : msg.slice(0, 1000);
        // apps row lives in the app's home region — fetch the right pool
        // before the UPDATE (queue pool may not have the row).
        const appPool = await getRuntimeDbForApp(controlDb, task.app_id).catch(() => null);
        if (appPool) {
          await appPool.query(
            `UPDATE apps SET provisioning_status = 'failed', provisioning_error = $1, updated_at = now() WHERE id = $2`,
            [genericError, task.app_id],
          ).catch(() => {});
          notifyProvisioningFailed(controlDb, appPool, { appId: task.app_id, provisioningError: genericError }).catch(() => {});
        }
      }

      logger.error({ taskId: task.id, appId: task.app_id, type: task.task_type }, '[neon-task-worker] Task permanently failed');
    } else {
      // Retry with backoff
      const backoff = BACKOFF_SECONDS[Math.min(task.attempts - 1, BACKOFF_SECONDS.length - 1)];
      await runtimePool.query(
        `UPDATE neon_tasks SET status = 'pending', locked_at = NULL, last_error = $1, run_after = now() + interval '${backoff} seconds' WHERE id = $2`,
        [msg.slice(0, 1000), task.id],
      );
    }
  }
}

/**
 * Provision a Neon database for an app. Logic extracted from provisionAppBackground.
 */
async function executeProvision(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  task: NeonTask,
  logger: Logger,
): Promise<void> {
  const appId = task.app_id;
  // The neon_tasks queue is per-region (the worker scans its local region),
  // but the apps row + app_db_connections row are in the app's home region
  // (which may differ from this worker's region). Resolve once up front.
  const runtimePool = await getRuntimeDbForApp(controlDb, appId);

  if (config.neon.enabled) {
    // The app's home region may differ from this worker's region.
    const appRegionRow = await runtimePool.query<{ region: string }>(
      `SELECT region FROM apps WHERE id = $1`,
      [appId],
    );
    if (appRegionRow.rows.length === 0) throw new Error(`neon-task-worker: app ${appId} not found`);
    const appRegion = appRegionRow.rows[0].region;

    const provisioned = await provisionNeonDbForApp(appRegion, appId);

    // app_db_connections is a runtime-tier table.
    // DO UPDATE, not DO NOTHING: the clone-resume re-provision path can reach
    // here with a row already present. Dropping the insert would leave the app
    // pointing at the old database while the freshly created tenant project
    // bills unrecorded. With project-per-tenant off this rewrites identical
    // values (same shared project id, same db_<appId> name).
    await runtimePool.query(
      `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id) DO UPDATE
         SET connection_string = EXCLUDED.connection_string,
             pooler_connection_string = EXCLUDED.pooler_connection_string,
             neon_project_id = EXCLUDED.neon_project_id,
             neon_database_name = EXCLUDED.neon_database_name`,
      [
        appId,
        provisioned.connectionUri,
        provisioned.poolerConnectionString,
        provisioned.neonProjectId,
        provisioned.neonDatabaseName,
      ],
    );

    await runMigrationsWithRetry(provisioned.connectionUri);
  } else {
    // Local dev
    const client = await dataPlaneDb.connect();
    try {
      await client.query(`CREATE DATABASE "${appId}" OWNER ${config.dataPlaneDb.user}`);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '42P04') {
        // already exists — continue
      } else {
        throw err;
      }
    } finally {
      client.release();
    }

    await runDataPlaneMigrations(appId);

    const localConnectionString = `postgresql://${config.dataPlaneDb.user}:${config.dataPlaneDb.password}@${config.pgbouncer.host}:${config.pgbouncer.port}/${appId}`;
    // app_db_connections is a runtime-tier table
    await runtimePool.query(
      `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
       VALUES ($1, $2, NULL, NULL, NULL)
       ON CONFLICT (app_id) DO NOTHING`,
      [appId, localConnectionString],
    );
  }

  // apps is a runtime-tier table
  await runtimePool.query(
    `UPDATE apps SET db_provisioned = true, provisioning_status = 'ready', updated_at = now() WHERE id = $1`,
    [appId],
  );
}

/**
 * Delete a Neon database and remove the app row.
 */
async function executeDeprovision(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  task: NeonTask,
  logger: Logger,
): Promise<void> {
  const appId = task.app_id;
  // The deprovision task lives in this worker's region's neon_tasks queue,
  // which IS the app's home region — neon_tasks is per-region and
  // enqueued by the delete route after resolving the app's region. Use
  // the local runtime pool directly: getRuntimeDbForApp would read
  // org_app_index, but the delete route already removed that entry
  // before enqueueing (init.ts:346), so cross-region lookup fails with
  // 'App not found'.
  const runtimePool = getRuntimeDbPool(config.runtimeDb, assertRegionConfig().instanceRegion);

  if (config.neon.enabled) {
    // app_db_connections is a runtime-tier table
    const connRow = await runtimePool.query<{ neon_project_id: string; neon_database_name: string }>(
      'SELECT neon_project_id, neon_database_name FROM app_db_connections WHERE app_id = $1',
      [appId],
    );

    if (connRow.rows.length > 0) {
      const { neon_project_id, neon_database_name } = connRow.rows[0];
      // teardownAppDb decides from the app's stored neon_project_id whether
      // this is a legacy database inside the region's shared data project or a
      // dedicated project-per-tenant project that must be deleted whole (else
      // it bills forever). Region is this worker's instance region, which is
      // the app's home region — see the comment on runtimePool above.
      // Idempotency (404 = already gone) is handled inside; other errors still
      // throw so the task retries, exactly as before.
      const result = await teardownAppDb({
        region: assertRegionConfig().instanceRegion,
        neonProjectId: neon_project_id,
        neonDatabaseName: neon_database_name,
      });
      if (result.degraded) {
        // getDataProjectIdForRegion threw for this worker's instance region —
        // see AppDbTeardownResult.degraded — so this fell back to the legacy
        // branch unable to prove it isn't actually an orphaned tenant project.
        logger.warn(
          { appId, neon_database_name, mode: result.mode, neonProjectId: result.projectId },
          '[neon-task-worker] Neon teardown fell back to legacy without verifying tenant status (region config gap)',
        );
      }
      if (result.alreadyGone) {
        logger.info(
          { appId, neon_database_name, mode: result.mode, neonProjectId: result.projectId, degraded: result.degraded },
          '[neon-task-worker] Neon resource already deleted, continuing',
        );
      }
    }
  } else {
    // Local dev — apps is a runtime-tier table
    const appRow = await runtimePool.query<{ db_name: string }>(
      'SELECT db_name FROM apps WHERE id = $1',
      [appId],
    );
    if (appRow.rows.length > 0) {
      await dataPlaneDb.query(`DROP DATABASE IF EXISTS "${appRow.rows[0].db_name}"`);
    }
  }

  // Delete the app row (cascade handles app_db_connections, app_users, etc.) — apps is runtime-tier
  await runtimePool.query('DELETE FROM apps WHERE id = $1', [appId]);
  logger.info({ appId }, '[neon-task-worker] App row deleted');

  // Safety-net: remove from org_app_index (idempotent — no-op if already removed by the DELETE route)
  await removeOrgAppIndex(controlDb, appId).catch((err) =>
    console.warn('[neon-task-worker] org_app_index remove failed', { err, appId }),
  );
}

/**
 * Poll the dest app's apps.provisioning_status until 'ready' or timeout.
 * Returns once provisioning completes; throws on failure or timeout.
 */
async function waitForDestReady(
  destRegion: string,
  destAppId: string,
  logger: Logger,
  timeoutMs: number = 5 * 60 * 1000,
): Promise<void> {
  // Use the region from the job row directly — getRuntimeDbForApp would go
  // through org_app_index, which provisionAppBackground populates only after
  // it finishes. We know the region at job-create time, so skip the lookup.
  const appPool = getRuntimeDbPool(config.runtimeDb, destRegion);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await appPool.query<{ provisioning_status: string }>(
      `SELECT provisioning_status FROM apps WHERE id = $1`,
      [destAppId],
    );
    const s = r.rows[0]?.provisioning_status;
    if (s === 'ready') return;
    if (s === 'failed') throw new Error('Dest app provisioning failed');
    if (s === undefined) {
      logger.warn({ destAppId }, '[clone] waitForDestReady: apps row not yet visible, will retry');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Dest app provisioning timed out');
}

/** A just-published-or-not release row, narrowed to the two fields this decision needs. */
export interface LatestReleaseForLineage {
  id: string;
  snapshot_id: string | null;
}

export interface LineageBaseDecision {
  /** Non-null only when the clone actually replayed this release's snapshot. */
  baseRelease: LatestReleaseForLineage | null;
  /** Always the snapshot the fork's repo HEAD was actually set to (see setLatest below). */
  baseSnapshotId: string;
}

/**
 * Pure decision for the FIX-1 bug: a fork's lineage base is the latest
 * published release ONLY when that release's snapshot matches the snapshot
 * the clone actually replayed (job.source_snapshot_id — the same value passed
 * to setLatest(resolvedDestAppId, job.source_snapshot_id) elsewhere in
 * executeClone, so the fork's repo HEAD literally *is* this value). If the
 * template owner has pushed further repo commits since the latest release,
 * the release is stale and must NOT be adopted as the base — the fork was
 * built from live state that has moved past it, and recording the release
 * pointer would make computeDivergence report an untouched fork as MODIFIED.
 *
 * Exported and tested in isolation because executeClone itself is a large,
 * heavily-effectful function (provisioning, S3, multiple DB pools) that is
 * impractical to exercise end to end in a unit test — this is the one
 * three-line expression inside it that actually needs coverage.
 */
export function decideLineageBase(
  latestRelease: LatestReleaseForLineage | null,
  sourceSnapshotId: string,
): LineageBaseDecision {
  const baseRelease =
    latestRelease?.snapshot_id === sourceSnapshotId ? latestRelease : null;
  return { baseRelease, baseSnapshotId: sourceSnapshotId };
}

/**
 * Phase 4a / Phase 5 B1 app-template clone: read job, provision fresh dest
 * app, copy blobs + manifest, set dest's latest pointer, mark job completed.
 *
 * Same-region: uses S3 server-side CopyObject (copyBlobSameRegion).
 * Cross-region: streams GET→PUT via copyBlobCrossRegion (Phase 5 B1).
 * The manifest is either server-side-copied (same region) or re-put from the
 * already-fetched JSON (cross-region, via putManifest).
 */
async function executeClone(
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  task: NeonTask,
  logger: Logger,
): Promise<void> {
  const jobId = task.task_meta?.job_id;
  if (!jobId) throw new Error('Clone task missing job_id in task_meta');

  const job = await getCloneJob(controlDb, jobId);
  if (!job) throw new Error(`Clone job ${jobId} not found`);
  if (isTerminalCloneStatus(job.status)) {
    logger.info({ jobId, status: job.status }, '[clone] job in terminal status; skipping');
    return;
  }
  // Any non-terminal status (including mid-stage: replaying_schema, replaying_rls,
  // seeding_data, replaying_functions, replaying_config, copying_repo) is a
  // resumable state. Each stage below is idempotent and its own guard decides
  // whether to skip or redo the work.
  const resumedFromStatus = job.status;

  await setCloneJobStatus(controlDb, jobId, { status: 'processing' });

  // Emit audit log on source app so source owners can see who cloned and when.
  await insertCloneAuditLog(controlDb, {
    appId: job.source_app_id,
    userId: job.requested_by_user_id,
    eventType: 'template_clone_started',
    metadata: { job_id: jobId, dest_region: job.dest_region },
  }).catch((err) => logger.error({ err }, '[clone] audit log started event insert failed'));

  // Hoist destAppId so the catch block can include it in the failed audit event.
  let destAppId: string | undefined;

  await Sentry.withScope(async (scope) => {
    scope.setTag('clone_job_id', jobId);
    scope.setTag('source_app_id', job.source_app_id);
    scope.setTag('target_app_id', 'pending');
    scope.setTag('resumed_from_status', resumedFromStatus);
    scope.setTag('attempt', String(task.attempts));

    try {
      scope.setTag('step', 'provisioning');

      // 1. Provision a fresh dest app via the existing path (mirrors init.ts:196-244).
      //    On retry, job.dest_app_id is already set from the prior attempt — reuse the
      //    ID to avoid creating a second orphaned app row + Neon database, but consult
      //    apps.provisioning_status to decide whether provisioning actually completed.
      //    Treating dest_app_id as proof of provisioning is unsafe: provisioning could
      //    have errored mid-flight (3D000, Neon outage, network blip), and resuming
      //    past it leaves waitForDestReady to bail forever on the stale 'failed' status.
      if (job.dest_app_id) {
        destAppId = job.dest_app_id;
        const destRuntimePool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
        const statusRow = await destRuntimePool.query<{ provisioning_status: string }>(
          `SELECT provisioning_status FROM apps WHERE id = $1`,
          [destAppId],
        );
        const ps = statusRow.rows[0]?.provisioning_status;

        if (ps === 'ready') {
          // Prior provision completed — nothing to redo.
          logger.info({ jobId, destAppId }, '[clone] resuming from prior attempt; dest already provisioned');
        } else if (ps === 'failed' || ps === undefined) {
          // Prior provision errored or the apps row went missing. Reset the
          // marker and re-run provisionAppBackground. With createDatabase
          // now blocking on waitUntilQueryable (neon-client.ts), the next
          // attempt won't lose the same propagation race.
          logger.warn(
            { jobId, destAppId, priorStatus: ps },
            '[clone] dest provisioning incomplete; re-provisioning',
          );
          await destRuntimePool.query(
            `UPDATE apps
                SET provisioning_status = 'provisioning',
                    provisioning_error  = NULL,
                    updated_at          = now()
              WHERE id = $1`,
            [destAppId],
          ).catch((err) => {
            logger.warn({ err, destAppId }, '[clone] failed to reset provisioning_status; continuing');
          });
          provisionAppBackground(job.dest_region, controlDb, dataPlaneDb, destAppId).catch((err) => {
            logger.error({ err, destAppId }, '[clone] provisionAppBackground rejected on re-provision');
          });
        } else {
          // 'provisioning' — a prior attempt is still mid-flight in background,
          // or a concurrent retry is racing. Fall through to waitForDestReady,
          // which polls to a terminal state.
          logger.info(
            { jobId, destAppId, priorStatus: ps },
            '[clone] resuming from prior attempt; dest provisioning in progress',
          );
        }
      } else {
        destAppId = generateAppId();
        const destName = job.dest_app_name ?? `Clone of ${job.source_app_id}`;

        // Resolve the destination org up-front. Passed into insertAppRow so
        // the runtime apps.organization_id lines up with the control-plane
        // org_app_index write below. Without this, insertAppRow would fall
        // back to resolveOrganizationId(user) → the requester's personal
        // org — mirroring the /init bug fixed in provisioner.ts — and the
        // clone would silently vanish from the target org's dashboard.
        //
        // Prefer the job's dest_organization_id (set by the clone route from
        // the same precedence /init uses). Fall back to the requester's
        // personal org for legacy jobs written before migration 092.
        const destOrgId = job.dest_organization_id
          ?? await resolveOrganizationId(controlDb, job.requested_by_user_id);

        await insertAppRow(job.dest_region, controlDb, destName, job.requested_by_user_id, destAppId, destOrgId);
        await setCloneJobStatus(controlDb, jobId, { dest_app_id: destAppId });

        // Reserve a subdomain for the dest. Mirrors routes/init.ts: derive
        // from the app name, check global uniqueness against org_app_index,
        // and append a short random suffix on collision. Required by the
        // WfP deploy path (deployViaWfp throws "requires app.subdomain"
        // without it) and by the dashboard's URL display, so we set it at
        // provision time rather than letting downstream steps re-discover
        // the gap. Underscores become hyphens to keep the host label DNS-safe.
        const baseSlug = destName.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '-');
        let destSubdomain = baseSlug;
        const taken = await controlDb.query<{ app_id: string }>(
          `SELECT app_id FROM org_app_index WHERE subdomain = $1`,
          [destSubdomain],
        );
        if (taken.rows.length > 0) {
          destSubdomain = `${baseSlug}-${Math.floor(Math.random() * 9000 + 1000)}`;
        }

        // Cross-region index so authorizeRepoRead/Write and other lookups can
        // resolve the dest app's region. Init route does the same step after
        // its insertAppRow; the clone worker is the equivalent caller here.
        await addOrgAppIndex(controlDb, {
          organizationId: destOrgId,
          appId: destAppId,
          region: job.dest_region,
          subdomain: destSubdomain,
          appName: destName,
        }).catch((err) => {
          logger.warn({ err, destAppId }, '[clone] org_app_index add failed; backfill will repair');
        });

        // Record template lineage on the dest app row (column added by Phase 1 migration).
        //    insertAppRow has no template_source_app_id parameter today — write it via
        //    a follow-up UPDATE on the dest's home runtime DB.
        //    template_source_region (added by B2 migration) lets the delete handler know
        //    which region pool to target without a fan-out lookup.
        //    Same UPDATE also writes the reserved subdomain (apps.subdomain is the
        //    truth source consulted by deployViaWfp / deployViaPages).
        const destRuntimePool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
        await destRuntimePool.query(
          `UPDATE apps
              SET template_source_app_id = $1,
                  template_source_region  = $2,
                  subdomain               = $4,
                  updated_at              = now()
            WHERE id = $3`,
          [job.source_app_id, job.source_region, destAppId, destSubdomain],
        );

        // Provision DB + run migrations. provisionAppBackground swallows errors
        // internally (sets provisioning_status='failed'), so waitForDestReady is
        // what surfaces failure back to us.
        provisionAppBackground(job.dest_region, controlDb, dataPlaneDb, destAppId).catch((err) => {
          logger.error({ err, destAppId }, '[clone] provisionAppBackground rejected');
        });
      }
      // destAppId is always assigned in both branches of the if/else above.
      const resolvedDestAppId = destAppId!;
      // Now that destAppId is resolved, update the Sentry tag.
      scope.setTag('target_app_id', resolvedDestAppId);
      await waitForDestReady(job.dest_region, resolvedDestAppId, logger);

      // Step 3 (Phase 5 A1): Replay source schema onto the dest DB.
      // Step 4 (Phase 5 A2): Replay source RLS policies onto the dest DB.
      // Step 8 (Phase 5 A3): Copy seed-flagged table rows onto the dest DB.
      // Pools are declared here so they can be shared across all three steps.
      const sourceRuntimePool = getRuntimeDbPool(config.runtimeDb, job.source_region);
      const sourceAppRowForPools = await sourceRuntimePool.query<{ db_name: string }>(
        `SELECT db_name FROM apps WHERE id = $1`,
        [job.source_app_id],
      );
      if (sourceAppRowForPools.rows.length === 0) {
        throw new Error(`[clone] source app ${job.source_app_id} not found in ${job.source_region} runtime DB`);
      }
      const sourceDbName = sourceAppRowForPools.rows[0].db_name;
      const sourceAppPool = await getAppPoolForApp(controlDb, job.source_app_id, sourceDbName);

      const destRuntimePool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
      const destAppRowForPools = await destRuntimePool.query<{ db_name: string }>(
        `SELECT db_name FROM apps WHERE id = $1`,
        [resolvedDestAppId],
      );
      if (destAppRowForPools.rows.length === 0) {
        throw new Error(`[clone] dest app ${resolvedDestAppId} not found in ${job.dest_region} runtime DB`);
      }
      const destDbNameForPools = destAppRowForPools.rows[0].db_name;
      const destAppPoolForReplay = await getAppPoolForApp(controlDb, resolvedDestAppId, destDbNameForPools);

      // A1: schema replay
      scope.setTag('step', 'replaying_schema');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_schema' });
      await replaySchema(sourceAppPool, destAppPoolForReplay, resolvedDestAppId, logger);

      // A2: RLS replay
      scope.setTag('step', 'replaying_rls');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_rls' });
      const rlsResult = await replayRls(sourceAppPool, destAppPoolForReplay, logger);
      if (rlsResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, rlsResult.warnings);
      }
      logger.info(
        { destAppId: resolvedDestAppId, replayed: rlsResult.replayed, warnings: rlsResult.warnings.length },
        '[clone] RLS replayed',
      );

      // 2. Read source manifest.
      scope.setTag('step', 'copying_repo');
      const manifestJson = await getManifestJson(job.source_app_id, job.source_snapshot_id);
      if (!manifestJson) throw new Error(`Source manifest ${job.source_snapshot_id} not found`);
      const manifest = JSON.parse(manifestJson) as { files: { path: string; sha256: string; size: number }[] };

      // 3. Copy blobs.
      const sameRegion = job.source_region === job.dest_region;
      const distinctShas = Array.from(new Set(manifest.files.map((f) => f.sha256)));
      if (sameRegion) {
        for (const sha of distinctShas) {
          await copyBlobSameRegion(job.source_app_id, resolvedDestAppId, sha);
        }
      } else {
        // Cross-region: stream GET from source S3 → PUT to dest S3.
        // In local dev both regions share one LocalStack endpoint; in production
        // each region has its own bucket/endpoint (injected via config).
        const s3Opts = {
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
          credentials: config.s3.accessKeyId && config.s3.secretAccessKey
            ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
            : undefined,
        };
        const srcS3 = new S3Client(s3Opts);
        const dstS3 = new S3Client(s3Opts);
        const bucket = config.s3.bucket;
        for (const sha of distinctShas) {
          await copyBlobCrossRegion(job.source_app_id, resolvedDestAppId, sha, srcS3, bucket, dstS3, bucket);
        }
      }

      // 4. Copy manifest.
      if (sameRegion) {
        await copyManifestSameRegion(job.source_app_id, resolvedDestAppId, job.source_snapshot_id);
      } else {
        await putManifest(resolvedDestAppId, job.source_snapshot_id, manifestJson);
      }

      // 5. Set dest's latest pointer + repo_latest_snapshot column. Use the
      //    region-direct pool (we already know dest's region from the job).
      await setLatest(resolvedDestAppId, job.source_snapshot_id);
      const destRuntimeAppPool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
      await destRuntimeAppPool.query(
        `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
        [job.source_snapshot_id, resolvedDestAppId],
      );

      // Step 8 (Phase 5 A3): Copy seed-flagged table rows onto the dest DB.
      scope.setTag('step', 'seeding_data');
      await setCloneJobStatus(controlDb, jobId, { status: 'seeding_data' });
      const seedResult = await replaySeedData(sourceAppPool, destAppPoolForReplay, logger);
      if (seedResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, seedResult.warnings);
      }
      logger.info({ destAppId: resolvedDestAppId, ...seedResult }, '[clone] seed data complete');

      // Replay app-level env vars BEFORE DO + function replay so both
      // downstream surfaces see the merged blob at first deploy/insert.
      try {
        const appEnvResult = await replayAppEnvVars(
          sourceRuntimePool, destRuntimePool,
          job.source_app_id, resolvedDestAppId, job.requested_by_user_id,
        );
        if (appEnvResult.copied) {
          logger.info(
            { destAppId: resolvedDestAppId, keyCount: appEnvResult.keyCount },
            '[clone] copied app_env_vars from source',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendCloneJobWarnings(controlDb, jobId, [`app_env_vars replay failed: ${msg}`]);
        logger.warn({ err, destAppId: resolvedDestAppId }, '[clone] app_env_vars replay failed; continuing');
      }

      // Read the staged env vars + auto-mint requests off the clone job row.
      // Hoisted above DO replay (previously read just before replayFunctions)
      // so DO replay can also consume the shared bb_sk_ minted for this clone.
      const cjRow = await controlDb.query<{
        pending_env_vars: string | null;
        auto_mint_requests: { fn_name: string; key: string }[] | null;
      }>(
        `SELECT pending_env_vars, auto_mint_requests FROM template_clone_jobs WHERE id = $1`,
        [jobId],
      );
      let pendingEnvVarValues: Record<string, Record<string, string>> | undefined;
      if (cjRow.rows[0]?.pending_env_vars) {
        const encKey = process.env.AUTH_ENCRYPTION_KEY;
        if (!encKey) {
          logger.warn({ jobId }, '[clone] pending_env_vars present but AUTH_ENCRYPTION_KEY missing; skipping env var staging');
        } else {
          try {
            pendingEnvVarValues = JSON.parse(decrypt(cjRow.rows[0].pending_env_vars, encKey)) as Record<string, Record<string, string>>;
          } catch (err) {
            logger.warn({ err, jobId }, '[clone] failed to decrypt pending_env_vars; proceeding without staged values');
          }
        }
      }
      const autoMintRequests = cjRow.rows[0]?.auto_mint_requests ?? undefined;

      // Resolve dest owner id once — needed for any auto-mint decision that
      // follows (bb_sk_ is minted under the dest owner's user_id). Hoisted
      // above DO replay so the DO side can share the same minted key with the
      // fn side (one shared credential per clone; intra-app bearer checks
      // between DO and fn only match when both carry the same value).
      const ownerRow = await destRuntimePool.query<{ owner_id: string }>(
        `SELECT owner_id FROM apps WHERE id = $1`,
        [resolvedDestAppId],
      );
      const destAppOwnerId = ownerRow.rows[0]?.owner_id;
      if (!destAppOwnerId) {
        throw new Error(
          `[clone] dest app ${resolvedDestAppId} has no owner_id in runtime DB — clone flow inconsistent`,
        );
      }

      // Resolve CLONE_APP_ENV_OVERRIDES once per clone. mint_hex specs produce
      // a single value here that is threaded into BOTH replayDurableObjectsForClone
      // and replayFunctions so DO signer + function verifiers share it.
      const appOverrides = resolveOverridesForClone(getCloneAppOverrides(), job.source_app_id);
      if (Object.keys(appOverrides).length > 0) {
        logger.info(
          { destAppId: resolvedDestAppId, sourceAppId: job.source_app_id, overrideKeys: Object.keys(appOverrides) },
          '[clone] CLONE_APP_ENV_OVERRIDES matched source app',
        );
      }

      // Mint the shared bb_sk_ once if EITHER side (DOs or functions) needs
      // it. Detection scans:
      //   - source DO env keys      (auto-mint if any match a convention key)
      //   - source fn env keys      (same)
      //   - caller's auto_mint_requests (per-fn explicit opt-in)
      // If nothing needs it, we don't mint at all. The mint call itself is
      // best-effort: transient failures surface as a warning and each side
      // leaves the affected keys unfilled. Preconditions (controlDb pool +
      // ownerId) are already satisfied here.
      let sourceDoEnvKeys: string[] = [];
      try {
        sourceDoEnvKeys = await listDoEnvVarKeys(sourceRuntimePool, job.source_app_id);
      } catch (dke) {
        logger.warn(
          { err: dke, sourceAppId: job.source_app_id },
          '[clone] listDoEnvVarKeys failed on source; DO auto-mint disabled for this clone',
        );
      }
      const doNeedsMint = sourceDoEnvKeys.some((k) => AUTO_MINT_CONVENTION_KEYS.includes(k));

      // We can't cheaply pre-list source fn env keys here (that read happens
      // inside replayFunctions). Mint eagerly only when the DO side needs it
      // or the caller explicitly opted in; otherwise defer to replayFunctions'
      // internal mint decision (unchanged path for the fn-only case).
      let sharedMintedKey: string | null = null;
      const explicitMintRequested = (autoMintRequests?.length ?? 0) > 0;
      if (doNeedsMint || explicitMintRequested) {
        try {
          const minted = await mintApiKeyForClone(controlDb, {
            ownerId: destAppOwnerId,
            destAppId: resolvedDestAppId,
          });
          sharedMintedKey = minted.key;
          logger.info(
            { destAppId: resolvedDestAppId, keyId: minted.keyId, doNeedsMint, explicitMintRequested },
            '[clone] shared API key minted for clone (shared across DO + fn replay)',
          );
        } catch (mintErr) {
          const msg = `shared key mint failed: ${(mintErr as Error).message}`;
          await appendCloneJobWarnings(controlDb, jobId, [msg]);
          logger.warn(
            { err: mintErr, destAppId: resolvedDestAppId },
            '[clone] shared key mint failed; DO auto-mint targets will remain unfilled',
          );
        }
      }

      // Replay Durable Object classes. Must run BEFORE replayFunctions so any
      // function env var pointing at a `<appId>_do` URL can be re-supplied by
      // the caller after they see the DO namespace exists on dest. Prior to
      // this step, DOs silently failed to clone: manage_durable_objects list
      // on the dest returned an empty array while functions still referenced
      // the source DO URLs (bug 6a04a0d5). DO env var VALUES are secrets and
      // never copied — only their KEYS surface, so the caller can re-set them
      // via manage_durable_objects action=set_env after clone completes. The
      // one exception is convention keys (BUTTERBASE_API_KEY / BB_SUBSTRATE_KEY):
      // when the shared bb_sk_ was minted above, those keys are auto-filled
      // so DO and fn on the cloned app share the same intra-app credential.
      scope.setTag('step', 'replaying_durable_objects');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_durable_objects' });
      try {
        const doResult = await replayDurableObjectsForClone(
          sourceRuntimePool,
          destRuntimePool,
          controlDb,
          job.source_app_id,
          resolvedDestAppId,
          job.requested_by_user_id,
          { sharedMintedKey, appOverrides },
        );
        if (doResult.cloned.length > 0) {
          logger.info(
            {
              destAppId: resolvedDestAppId,
              cloned: doResult.cloned,
              doEnvKeys: doResult.do_env_keys,
              autoMintedKeys: doResult.auto_minted_keys,
            },
            '[clone] durable objects replayed',
          );
          const overrideFilled = doResult.override_filled_keys;
          const unfilled = doResult.do_env_keys.filter(
            (k) => !doResult.auto_minted_keys.includes(k) && !overrideFilled.includes(k),
          );
          if (unfilled.length > 0) {
            await appendCloneJobWarnings(controlDb, jobId, [
              `Durable Objects cloned: ${doResult.cloned.join(', ')}. Unfilled DO env keys (${unfilled.join(', ')}) are secrets that were not copied — set them via manage_durable_objects action=set_env after the clone completes.`,
            ]);
          }
        } else {
          logger.info({ destAppId: resolvedDestAppId }, '[clone] no active durable objects on source');
        }
      } catch (err) {
        // DO replay failure is not silently ignored — surface it as a fatal
        // clone-job failure so the caller notices instead of getting a
        // "completed" clone whose DOs are half-deployed.
        throw err;
      }

      // Step 5 (Phase 5 A4): Replay app_functions from source runtime DB to dest runtime DB.
      // pendingEnvVarValues, autoMintRequests, and destAppOwnerId are resolved
      // above the DO replay step so the DO side can share the minted key with
      // the fn side. `preMintedSharedKey` tells replayFunctions to reuse the
      // orchestrator-level mint instead of minting a second key.
      scope.setTag('step', 'replaying_functions');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_functions' });

      const fnResult = await replayFunctions(
        sourceRuntimePool,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        job.requested_by_user_id,
        logger,
        {
          pendingEnvVarValues,
          autoMintRequests,
          controlPool: controlDb,
          destAppOwnerId,
          preMintedSharedKey: sharedMintedKey,
          appOverrides,
        },
      );
      if (fnResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, fnResult.warnings);
      }

      // Persist the post-replay summary + clear transient staging blobs in one UPDATE.
      // We never want values lingering on the job row past the point they're applied.
      await controlDb.query(
        `UPDATE template_clone_jobs
            SET unfilled_env_vars  = $1::jsonb,
                pending_env_vars   = NULL,
                auto_mint_requests = NULL,
                updated_at         = now()
          WHERE id = $2`,
        [JSON.stringify(fnResult.unfilledEnvVars), jobId],
      ).catch((err) => {
        // Don't fail the whole clone if this side-effect can't be persisted.
        logger.warn({ err, jobId }, '[clone] failed to persist unfilled_env_vars summary');
      });

      logger.info(
        {
          destAppId: resolvedDestAppId,
          count: fnResult.count,
          warnings: fnResult.warnings.length,
          unfilledFunctions: Object.keys(fnResult.unfilledEnvVars).length,
        },
        '[clone] functions replayed',
      );

      // Step 6 (Phase 5 A5): Replay non-secret config onto dest runtime DB.
      scope.setTag('step', 'replaying_config');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_config' });
      const cfgResult = await replayNonSecretConfig(
        sourceRuntimePool,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        logger,
      );
      if (cfgResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, cfgResult.warnings);
      }
      logger.info(
        { destAppId: resolvedDestAppId, warnings: cfgResult.warnings.length },
        '[clone] non-secret config replayed',
      );

      // Step 6a-bis: Mint a fresh meetings-webhook config for the dest if the
      // source had one. Lives in the control DB (not runtime), so kept out of
      // replayNonSecretConfig which only touches runtime tables.
      const meetingsWebhookResult = await replayMeetingsWebhook(
        controlDb,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        logger,
      );
      if (meetingsWebhookResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, meetingsWebhookResult.warnings);
      }
      // If the new wsec_* was wired directly into the receiver function's env
      // vars, strip NOTETAKER_WEBHOOK_SECRET from the persisted unfilled list
      // so the dashboard banner doesn't keep asking the cloner to set it.
      if (meetingsWebhookResult.filledFnEnvVar) {
        const { fnName, key } = meetingsWebhookResult.filledFnEnvVar;
        const remaining = { ...fnResult.unfilledEnvVars };
        const fnEntry = remaining[fnName];
        if (fnEntry && fnEntry.includes(key)) {
          const filtered = fnEntry.filter((k) => k !== key);
          if (filtered.length > 0) remaining[fnName] = filtered;
          else delete remaining[fnName];
          await controlDb.query(
            `UPDATE template_clone_jobs SET unfilled_env_vars = $1::jsonb, updated_at = now() WHERE id = $2`,
            [JSON.stringify(remaining), jobId],
          ).catch((err) => {
            logger.warn({ err, jobId }, '[clone] failed to strip notetaker secret from unfilled_env_vars');
          });
        }
      }
      logger.info(
        { destAppId: resolvedDestAppId, minted: meetingsWebhookResult.minted },
        '[clone] meetings webhook step complete',
      );

      // Step 6b (Phase 5 A6): Replay auth_hook_function binding — only if the
      // referenced function was replicated successfully (A4). Runs after
      // replayNonSecretConfig so the binding cannot be clobbered by config replay.
      // (Runs under the same 'replaying_config' step tag.)
      const hookResult = await replayAuthHookBinding(
        sourceRuntimePool,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        logger,
      );
      if (hookResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, hookResult.warnings);
      }
      logger.info(
        { destAppId: resolvedDestAppId, warnings: hookResult.warnings.length },
        '[clone] auth_hook_function binding step complete',
      );

      // Step 6c: Replay substrate link — binds dest's apps.substrate_organization_id
      // to the CLONER's org (not the source owner) so cloned apps using
      // ctx.substrate don't 403 SUBSTRATE_NOT_LINKED. Runs under the same
      // 'replaying_config' step tag.
      //
      // Preconditions:
      //   1. cloner has a personal_organization_id (guaranteed by the orgs
      //      signup hook; every prod user has one). If missing, the substrate
      //      link CANNOT be replayed — hard-fail rather than continue with a
      //      silent warning that leaves the clone's ctx.substrate broken.
      //   2. If source was never linked, we no-op regardless of cloner state
      //      (nothing to replay). The check below handles both branches.
      const clonerOrgLookup = await controlDb.query<{ personal_organization_id: string | null }>(
        `SELECT personal_organization_id FROM platform_users WHERE id = $1`,
        [job.requested_by_user_id],
      );
      const clonerOrgId = clonerOrgLookup.rows[0]?.personal_organization_id ?? null;
      let substrateResult: { warnings: string[] };
      if (clonerOrgId) {
        substrateResult = await replaySubstrateLink(
          sourceRuntimePool,
          destRuntimePool,
          job.source_app_id,
          resolvedDestAppId,
          clonerOrgId,
          logger,
        );
      } else {
        // Check whether the source is actually substrate-linked. If not, silent
        // no-op is correct — the cloner not having a personal org doesn't matter
        // when there's nothing to replay. If it IS linked, we cannot proceed
        // and must fail the whole clone step so the cloner sees the problem.
        const srcCheck = await sourceRuntimePool.query<{ substrate_organization_id: string | null }>(
          `SELECT substrate_organization_id FROM apps WHERE id = $1`,
          [job.source_app_id],
        );
        const sourceIsLinked = !!srcCheck.rows[0]?.substrate_organization_id;
        if (sourceIsLinked) {
          throw new Error(
            `substrate-link replay: cloner ${job.requested_by_user_id} has no personal_organization_id, ` +
              `but source app ${job.source_app_id} is substrate-linked. Cannot silently drop the link on clone; ` +
              `provision the cloner's personal org (re-auth via signup hook) and retry.`,
          );
        }
        substrateResult = { warnings: [] };
      }
      if (substrateResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, substrateResult.warnings);
      }
      logger.info(
        { destAppId: resolvedDestAppId, warnings: substrateResult.warnings.length },
        '[clone] substrate link step complete',
      );

      // Step 7: replay the source's most recent published frontend by copying
      // its persisted artifact slot (app-artifact/{appId}.zip) onto the dest
      // and re-publishing through the same pipeline. Best-effort: a failure
      // here records a warning but does not fail the broader clone — the
      // backend is fully cloned at this point, and the user can re-publish
      // the frontend manually if needed.
      scope.setTag('step', 'replaying_frontend');
      const frontendResult = await replayFrontend(
        controlDb,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        job.requested_by_user_id,
        logger,
      );
      if (frontendResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, frontendResult.warnings);
      }

      scope.setTag('step', 'finalizing');

      // A7: Ensure dest.db_provisioned=true. provisionAppBackground already sets this
      // when provisioning_status becomes 'ready' (which waitForDestReady confirmed), but
      // we assert it here explicitly so the finalization block is self-contained and
      // robust to any future refactor that might decouple those two writes.
      await destRuntimePool.query(
        `UPDATE apps SET db_provisioned = true, updated_at = now() WHERE id = $1`,
        [resolvedDestAppId],
      );
      logger.info({ destAppId: resolvedDestAppId }, '[clone] dest.db_provisioned=true confirmed');

      // A7: Increment source fork_count.
      // Migration 014 only installs a trigger for the decrement-on-delete case;
      // there is no INSERT trigger that auto-increments fork_count for same-region
      // clones. The worker is therefore always responsible for the increment,
      // regardless of whether source and dest share a region.
      //
      // For cross-region: we use the source's per-region pool explicitly, which
      // is the only way to reach the source's runtime DB from the dest worker.
      // For same-region: the source's runtime pool and the dest's are the same
      // physical DB, but we still use getRuntimeDbPool(source_region) for clarity.
      //
      // B2 sweeper reconciles if this fails (non-fatal catch below).
      try {
        const sourceRuntimePoolForForkCount = getRuntimeDbPool(config.runtimeDb, job.source_region);
        // B2 audit 2026-06-01: no INSERT trigger on apps auto-increments fork_count; unconditional bump is correct.
        await sourceRuntimePoolForForkCount.query(
          `UPDATE apps SET fork_count = COALESCE(fork_count, 0) + 1 WHERE id = $1`,
          [job.source_app_id],
        );
        logger.info(
          { source: job.source_app_id, sourceRegion: job.source_region, destRegion: job.dest_region },
          '[clone] incremented source.fork_count',
        );
      } catch (err) {
        // Don't fail the clone over fork_count; B2 sweeper will reconcile.
        logger.error(
          { err, source: job.source_app_id },
          '[clone] fork_count increment failed; deferring to sweeper',
        );
      }

      // Record template lineage in the control plane. Additive and best-effort:
      // this must never fail a clone that has otherwise succeeded. The base is
      // captured HERE because it can only be captured at clone time — a fork
      // created without it can never be safely merged later, since by the time we
      // want a base it has already diverged.
      try {
        const releases = await listReleases(controlDb, job.source_app_id, 1);
        const { baseRelease, baseSnapshotId } = decideLineageBase(
          releases[0] ?? null,
          job.source_snapshot_id,
        );
        // Point at the release when one exists; materialize inline only when the
        // fork was cloned from live. Never both.
        const baseFingerprint = baseRelease
          ? null
          : await captureAppState(sourceRuntimePool, sourceAppPool, job.source_app_id);

        await recordLineage(controlDb, {
          destAppId: resolvedDestAppId,
          destRegion: job.dest_region,
          sourceAppId: job.source_app_id,
          sourceRegion: job.source_region,
          baseReleaseId: baseRelease?.id ?? null,
          baseFingerprint,
          baseSnapshotId,
        });
        logger.info(
          { destAppId: resolvedDestAppId, baseReleaseId: baseRelease?.id ?? null },
          '[clone] lineage recorded',
        );
      } catch (err) {
        logger.warn(
          { err, destAppId: resolvedDestAppId },
          '[clone] lineage record failed; backfill will repair',
        );
      }

      // 6. Mark job completed.
      const completedAt = new Date();
      await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: completedAt });

      // Enqueue webhook outbox row for the source app (sweeper will skip if no webhook configured).
      enqueueWebhookDelivery(controlDb, {
        appId: job.source_app_id,
        jobId,
        sourceAppId: job.source_app_id,
        destAppId: resolvedDestAppId,
        destRegion: job.dest_region,
        completedAt,
      }).catch((err) => logger.error({ err }, '[clone] enqueueWebhookDelivery (source) failed'));

      // Enqueue webhook outbox row for the dest app (sweeper will skip if no webhook configured).
      enqueueWebhookDelivery(controlDb, {
        appId: resolvedDestAppId,
        jobId,
        sourceAppId: job.source_app_id,
        destAppId: resolvedDestAppId,
        destRegion: job.dest_region,
        completedAt,
      }).catch((err) => logger.error({ err }, '[clone] enqueueWebhookDelivery (dest) failed'));

      // Emit completed audit event on source app.
      await insertCloneAuditLog(controlDb, {
        appId: job.source_app_id,
        userId: job.requested_by_user_id,
        eventType: 'template_clone_completed',
        metadata: { job_id: jobId, dest_app_id: resolvedDestAppId, dest_region: job.dest_region },
      }).catch((err) => logger.error({ err }, '[clone] audit log completed event insert failed'));

      logger.info({ jobId, destAppId: resolvedDestAppId }, '[clone] completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The neon-task queue retries up to task.max_attempts (line 184). If we mark
      // the clone job 'failed' on every throw, the guard at line 435 short-circuits
      // every retry attempt with "job in terminal status; skipping". Only mark the
      // clone job failed once the task has truly exhausted retries; on transient
      // failures, leave status='processing' so the requeued task can resume.
      const isPermanent = task.attempts >= task.max_attempts;

      if (isPermanent) {
        // Best-effort failure marker; swallow secondary errors so we still rethrow the original.
        await setCloneJobStatus(controlDb, jobId, { status: 'failed', error_message: msg }).catch(() => {});

        // Emit failed audit event on source app. Wrap in catch so we don't compound the original error.
        await insertCloneAuditLog(controlDb, {
          appId: job.source_app_id,
          userId: job.requested_by_user_id,
          eventType: 'template_clone_failed',
          metadata: { job_id: jobId, dest_app_id: destAppId ?? null, dest_region: job.dest_region, error: msg },
        }).catch((auditErr) => logger.error({ auditErr }, '[clone] audit log failed event insert failed'));

        // Notify the dest owner (and ops) that their clone permanently failed. The dest app
        // exists at this point (destAppId is set once provisioning succeeds); if provisioning
        // itself failed, notifyProvisioningFailed already fired from the same catch path via
        // the ambient provisioning task, so we skip to avoid a duplicate email.
        if (destAppId) {
          const destRuntimePool = await getRuntimeDbForApp(controlDb, destAppId).catch(() => null);
          if (destRuntimePool) {
            notifyCloneFailed(
              controlDb,
              destRuntimePool,
              {
                appId: destAppId,
                jobId,
                sourceAppId: job.source_app_id,
                errorMessage: msg,
              },
              logger,
            ).catch((notifyErr) => logger.error({ notifyErr, jobId }, '[clone] notifyCloneFailed failed'));
          }
        }
      } else {
        // Surface the last error to the user but keep the job alive for the next attempt.
        await setCloneJobStatus(controlDb, jobId, { error_message: msg }).catch(() => {});
        logger.warn(
          { jobId, attempt: task.attempts, maxAttempts: task.max_attempts, error: msg },
          '[clone] transient failure, will retry',
        );
      }

      throw err; // re-throw so the neon-task queue applies its retry/fail logic
    }
  });
}

// ---------------------------------------------------------------------------
// Template update (mode='update'): reset a fork's CODE to the latest release
// while every row in its database survives.
// ---------------------------------------------------------------------------

/**
 * Re-checked at execution time, not just at request time. A fork edited between
 * the click and the worker picking the job up must abort, not reset — the
 * request-time gate proves nothing about the state of the fork now, and by the
 * time this runs we are about to overwrite its code.
 *
 * Delegates to decideEligibility so the request-time and execution-time gates
 * cannot drift apart: a rule added to one is automatically enforced by the
 * other. A null divergence (unreadable fork DB) is treated as ineligible by
 * decideEligibility, so an unreachable fork aborts rather than being reset
 * blind.
 *
 * Exported and unit-tested in isolation for the same reason decideLineageBase
 * is: executeUpdate itself touches S3 and three pools, so the one decision that
 * actually protects customer data would otherwise have no direct coverage.
 */
export function shouldAbortUpdate(
  divergenceNow: Divergence | null,
  drift: DriftResult,
): { abort: boolean; reason: string } {
  const decision = decideEligibility(drift, divergenceNow);
  return decision.eligible
    ? { abort: false, reason: 'ok' }
    : { abort: true, reason: decision.reason };
}

/**
 * Which execution path a `clone` task belongs to. One task_type carries both
 * directions of the template pipeline; the job row's `mode` is the only thing
 * that distinguishes "make me a new fork" from "reset this existing fork's code
 * to the latest release". A missing job resolves to 'clone' so executeClone can
 * raise the precise error for that case.
 *
 * Exported for the same reason decideLineageBase is: it is a one-line decision
 * inside an untestable effectful caller, and getting it wrong points a
 * destructive update at a fresh-provision path (or vice versa).
 */
export function resolveCloneDispatch(job: { mode?: string } | null): 'clone' | 'update' {
  return job?.mode === 'update' ? 'update' : 'clone';
}

/** How a resumed update should treat the fork's current repo HEAD. */
export type UpdateResumeState = 'fresh' | 'republish' | 'ambiguous';

/**
 * Repo snapshots are content-addressed, so the snapshot this job WILL publish is
 * computable before anything is written. That makes the fork's current HEAD
 * legible on a resumed attempt:
 *
 *   - HEAD is the pre-update snapshot, or no attempt has begun → 'fresh'. Nothing
 *     of ours has landed, so the full eligibility gate applies exactly as it does
 *     on a first attempt. This is the case that protects an owner who worked on
 *     the fork for two weeks and then hit Retry: their edits are still measured.
 *   - HEAD is the snapshot THIS job publishes → 'republish'. A prior attempt of
 *     this same job already wrote it, so the repo divergence is ours, not a user
 *     edit, and the fork is mid-update. Finishing is the way out.
 *   - HEAD is neither → 'ambiguous'. Something moved the fork's repo that is not
 *     this job. Never reset on a guess.
 *
 * 'republish' requires a recorded pre-sync marker: without one no attempt has
 * ever passed the gate, so a HEAD that merely happens to match cannot be
 * evidence of our own prior write.
 */
export function classifyUpdateResume(args: {
  preSyncSnapshotId: string | null;
  currentHead: string | null;
  targetSnapshotId: string;
}): UpdateResumeState {
  if (args.preSyncSnapshotId === null) return 'fresh';
  if (args.currentHead === args.preSyncSnapshotId) return 'fresh';
  if (args.currentHead === args.targetSnapshotId) return 'republish';
  return 'ambiguous';
}

/**
 * In-place template update. Unlike executeClone, nothing is provisioned: the
 * destination app already exists and keeps its database, its rows, its env vars,
 * its secrets, its OAuth and integration credentials, and its deployed frontend.
 * Only code-shaped surfaces are replaced — repo blobs, function bodies,
 * additive-only schema DDL, additive RLS policies, and config rows the fork does
 * not already have.
 *
 * Resumability matches executeClone: any non-terminal status is resumable and
 * every stage is idempotent, so a requeued task redoes stages rather than
 * skipping them.
 *
 * Exported for testing. Nothing else should call it — dispatch goes through
 * processNextTask.
 */
export async function executeUpdate(
  controlDb: pg.Pool,
  task: NeonTask,
  logger: Logger,
): Promise<void> {
  const jobId = task.task_meta?.job_id;
  if (!jobId) throw new Error('Update task missing job_id in task_meta');

  const job = await getCloneJob(controlDb, jobId);
  if (!job) throw new Error(`Update job ${jobId} not found`);
  if (isTerminalCloneStatus(job.status)) {
    logger.info({ jobId, status: job.status }, '[update] job in terminal status; skipping');
    return;
  }

  // createUpdateJob guarantees dest_app_id is the fork; the partial unique index
  // enforcing "one in-flight update per fork" depends on it being non-null.
  const forkAppId = job.dest_app_id;
  if (!forkAppId) throw new Error(`Update job ${jobId} has no dest_app_id (fork app)`);

  // Precondition, not an epilogue. The lineage advance at the end of this
  // function needs a release to point the fork's new base at; discovering it is
  // missing after the repo, schema, functions and config have all been replaced
  // leaves the fork mutated with a base_snapshot_id still on the old HEAD —
  // permanently ineligible for any further update and displaying as
  // user-modified. createUpdateJob types it as a string, but the column is
  // nullable, so check before touching anything.
  if (!job.target_release_id) {
    throw new Error(
      `Update job ${jobId} has no target_release_id; refusing to start an update ` +
        'whose lineage base could not be recorded',
    );
  }

  await setCloneJobStatus(controlDb, jobId, { status: 'processing' });

  await Sentry.withScope(async (scope) => {
    scope.setTag('clone_job_id', jobId);
    scope.setTag('clone_mode', 'update');
    scope.setTag('source_app_id', job.source_app_id);
    scope.setTag('target_app_id', forkAppId);
    scope.setTag('attempt', String(task.attempts));

    try {
      const forkRuntimePool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
      const sourceRuntimePool = getRuntimeDbPool(config.runtimeDb, job.source_region);

      const forkRow = await forkRuntimePool.query<{
        db_name: string; owner_id: string; repo_latest_snapshot: string | null;
      }>(
        `SELECT db_name, owner_id, repo_latest_snapshot FROM apps WHERE id = $1`,
        [forkAppId],
      );
      if (forkRow.rows.length === 0) {
        throw new Error(`[update] fork app ${forkAppId} not found in ${job.dest_region} runtime DB`);
      }
      const { db_name: forkDbName, owner_id: forkOwnerId } = forkRow.rows[0];
      const currentHead = forkRow.rows[0].repo_latest_snapshot;

      const sourceRow = await sourceRuntimePool.query<{ db_name: string }>(
        `SELECT db_name FROM apps WHERE id = $1`,
        [job.source_app_id],
      );
      if (sourceRow.rows.length === 0) {
        throw new Error(`[update] source app ${job.source_app_id} not found in ${job.source_region} runtime DB`);
      }

      const forkAppPool = await getAppPoolForApp(controlDb, forkAppId, forkDbName);
      const sourceAppPool = await getAppPoolForApp(controlDb, job.source_app_id, sourceRow.rows[0].db_name);

      // -- 1. PREPARE the repo. Nothing here is visible to the fork: blobs are
      //       content-addressed and unreferenced until a manifest names them, and
      //       the fork's HEAD is untouched. Deliberately done BEFORE the gate,
      //       because the snapshot id it yields is what makes a resumed attempt's
      //       HEAD legible (see classifyUpdateResume).
      scope.setTag('step', 'copying_repo');
      await setCloneJobStatus(controlDb, jobId, { status: 'copying_repo' });

      const manifestJson = await getManifestJson(job.source_app_id, job.source_snapshot_id);
      if (!manifestJson) throw new Error(`Source manifest ${job.source_snapshot_id} not found`);
      const manifest = JSON.parse(manifestJson) as { files: RepoManifestEntry[]; message?: string };

      // Land the source blobs under the fork's own prefix first, so the rewrite
      // pass reads every blob from one region-local bucket regardless of where
      // the template lives.
      const sameRegion = job.source_region === job.dest_region;
      const distinctShas = Array.from(new Set(manifest.files.map((f) => f.sha256)));
      if (sameRegion) {
        for (const sha of distinctShas) {
          await copyBlobSameRegion(job.source_app_id, forkAppId, sha);
        }
      } else {
        const s3Opts = {
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
          credentials: config.s3.accessKeyId && config.s3.secretAccessKey
            ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
            : undefined,
        };
        const srcS3 = new S3Client(s3Opts);
        const dstS3 = new S3Client(s3Opts);
        for (const sha of distinctShas) {
          await copyBlobCrossRegion(job.source_app_id, forkAppId, sha, srcS3, config.s3.bucket, dstS3, config.s3.bucket);
        }
      }

      const rewritten = await rewriteManifestEntries(
        manifest.files,
        (sha) => getBlobBuffer(forkAppId, sha),
        (sha, content) => putBlobBuffer(forkAppId, sha, content),
        job.source_app_id,
        forkAppId,
      );

      // validateManifest canonicalises exactly the way the repo push path does,
      // so the fork's new HEAD is a legitimate content-addressed snapshot rather
      // than a synthetic id — and the same inputs always yield the same id, which
      // is what the resume classification relies on.
      const newSnapshot = validateManifest({ files: rewritten, message: manifest.message });

      // -- 2. Gate, re-evaluated against the fork as it is RIGHT NOW.
      scope.setTag('step', 'eligibility_recheck');
      const resume = classifyUpdateResume({
        preSyncSnapshotId: job.pre_sync_snapshot_id,
        currentHead,
        targetSnapshotId: newSnapshot.snapshotId,
      });
      scope.setTag('resume_state', resume);

      const drift = await computeDrift(controlDb, forkAppId);

      const failWithoutRetry = async (reason: string) => {
        logger.warn({ jobId, forkAppId, reason, resume }, '[update] aborting; fork not eligible');
        await setCloneJobStatus(controlDb, jobId, {
          status: 'failed',
          error_message: `Update aborted at execution time: ${reason}`,
          completed_at: new Date(),
        });
      };

      if (resume === 'ambiguous') {
        // The fork's repo moved to something that is neither where we found it
        // nor what we are about to publish. That is an edit we cannot attribute,
        // and resetting on a guess is the one outcome that destroys work.
        await failWithoutRetry(
          `fork repo changed since the update was queued (HEAD ${currentHead ?? 'none'} ` +
            `matches neither the pre-update snapshot nor the target)`,
        );
        return;
      }

      if (resume === 'fresh') {
        let divergenceNow: Divergence | null = null;
        try {
          divergenceNow = await computeDivergence(controlDb, forkRuntimePool, forkAppPool, forkAppId);
        } catch (err) {
          // Leave it null: decideEligibility reads null as 'unknown' and aborts.
          // Resetting a fork whose current state we could not read is the one
          // outcome that destroys data.
          logger.warn({ err, forkAppId }, '[update] divergence check failed; treating as unknown');
        }
        const { abort, reason } = shouldAbortUpdate(divergenceNow, drift);
        if (abort) {
          // Deliberately NOT thrown: a terminal business decision, not a
          // transient fault, and must not be retried by the neon-task queue.
          await failWithoutRetry(reason);
          return;
        }
      } else {
        // 'republish': a prior attempt of this job already published the target
        // snapshot, so every divergence signal now reflects OUR half-finished
        // work — measuring it would fail the job forever and strand the fork
        // mid-update. Only the facts a partial update cannot have caused still
        // gate: lineage being severed, or the row no longer being a fork at all.
        if (!drift.is_fork || drift.severed) {
          await failWithoutRetry(drift.is_fork ? 'severed' : 'not_a_fork');
          return;
        }
        logger.info(
          { jobId, forkAppId, snapshotId: newSnapshot.snapshotId },
          '[update] resuming a partially applied update; finishing it',
        );
      }

      // -- 3. Record the pre-update repo HEAD for the undo route. Written after
      //       the gate and before the first visible write, and only once — a
      //       resumed attempt must not overwrite it with the half-updated HEAD.
      //
      //       This marker is also what classifyUpdateResume keys on, so
      //       createUpdateJob MUST leave pre_sync_snapshot_id NULL at creation
      //       time. A route that pre-fills it would make every job look resumed
      //       on its very first attempt.
      if (job.pre_sync_snapshot_id === null) {
        if (!currentHead) {
          logger.warn({ jobId, forkAppId }, '[update] fork has no repo HEAD; undo will be unavailable');
        }
        await controlDb.query(
          `UPDATE template_clone_jobs
              SET pre_sync_snapshot_id = $1, updated_at = now()
            WHERE id = $2 AND pre_sync_snapshot_id IS NULL`,
          [currentHead, jobId],
        );
      }

      // -- 4. PUBLISH the prepared repo. First write the fork can observe.
      await putManifest(forkAppId, newSnapshot.snapshotId, newSnapshot.canonicalJson);
      await setLatest(forkAppId, newSnapshot.snapshotId);
      await forkRuntimePool.query(
        `UPDATE apps SET repo_latest_snapshot = $1, updated_at = now() WHERE id = $2`,
        [newSnapshot.snapshotId, forkAppId],
      );
      logger.info(
        { jobId, forkAppId, snapshotId: newSnapshot.snapshotId, fileCount: rewritten.length },
        '[update] repo replaced',
      );

      // NOTE: the fork's deployed frontend artifact is deliberately NOT touched.
      // The new code is in the repo; publishing it is the fork owner's call.

      // -- 5. Schema — additive statements only. filterAdditive withholds anything
      //       that drops or narrows, because the fork's rows are the whole point
      //       of an in-place update; every rejection is logged by replaySchema.
      scope.setTag('step', 'replaying_schema');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_schema' });
      await replaySchema(sourceAppPool, forkAppPool, forkAppId, logger, { filter: filterAdditive });

      // -- 6. RLS. replayRls only issues CREATE POLICY and drops nothing, so it is
      //       safe on a live fork — and necessary: a table the release adds is
      //       created here with SELECT/INSERT/UPDATE/DELETE granted to
      //       butterbase_anon by the schema applier, so skipping policy replay
      //       would publish that table wide open on every fork.
      //
      //       Policies the fork already has make CREATE POLICY fail with
      //       "already exists"; replayRls catches per policy, so those are
      //       expected no-ops and are filtered out of the job warnings rather
      //       than shown to the owner as problems.
      scope.setTag('step', 'replaying_rls');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_rls' });
      const rlsResult = await replayRls(sourceAppPool, forkAppPool, logger);
      const rlsWarnings = rlsResult.warnings.filter((w) => !/already exists/i.test(w));
      if (rlsWarnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, rlsWarnings);
      }
      logger.info(
        {
          jobId, forkAppId,
          replayed: rlsResult.replayed,
          preExisting: rlsResult.warnings.length - rlsWarnings.length,
          warnings: rlsWarnings.length,
        },
        '[update] RLS policies replayed',
      );

      // -- 7. Functions — overwrite bodies and triggers of functions the fork
      //       already has, insert the ones the template added. replayFunctions
      //       leaves the env vars of pre-existing functions untouched (see the
      //       wasInserted guard in clone-replay.ts): a fork's secrets are not
      //       ours to replace.
      scope.setTag('step', 'replaying_functions');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_functions' });
      const fnResult = await replayFunctions(
        sourceRuntimePool,
        forkRuntimePool,
        job.source_app_id,
        forkAppId,
        job.requested_by_user_id,
        logger,
        { overwriteExisting: true, controlPool: controlDb, destAppOwnerId: forkOwnerId },
      );
      if (fnResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, fnResult.warnings);
      }
      logger.info(
        { jobId, forkAppId, count: fnResult.count, warnings: fnResult.warnings.length },
        '[update] functions replayed',
      );

      // -- 8. Config, insert-only. Config replay was written for an empty clone
      //       target; pointed at a live fork its overwrite branches NULL the
      //       fork's OAuth client secret, re-mint its Composio credentials, and
      //       replace its allowed origins. insertOnly adds what the fork lacks
      //       and touches nothing it already has.
      scope.setTag('step', 'replaying_config');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_config' });
      const cfgResult = await replayNonSecretConfig(
        sourceRuntimePool, forkRuntimePool, job.source_app_id, forkAppId, logger,
        { insertOnly: true },
      );
      if (cfgResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, cfgResult.warnings);
      }

      // -- 9. Advance the fork's lineage base to what it now actually is.
      //
      //       NOT best-effort. If this write is skipped, base_snapshot_id still
      //       points at the old HEAD while apps.repo_latest_snapshot holds the new
      //       one, so computeDivergence reports repo: true — the fork displays as
      //       user-modified and is permanently ineligible for any future update,
      //       recoverable only by hand-editing app_lineage. The write is
      //       idempotent and cheap, so throwing and letting the queue retry is
      //       strictly better than logging and moving on.
      //
      //       base_release_id drives behind_by. The fingerprint is captured from
      //       the fork's post-update state rather than inherited from the release
      //       manifest, because the additive-only schema filter means the fork is
      //       allowed to differ from the release in ways that are not user edits.
      scope.setTag('step', 'advancing_lineage');
      const fingerprint = await captureAppState(forkRuntimePool, forkAppPool, forkAppId);
      await controlDb.query(
        `UPDATE app_lineage
            SET base_release_id  = $1,
                base_snapshot_id = $2,
                base_fingerprint = $3::jsonb
          WHERE dest_app_id = $4`,
        [job.target_release_id, newSnapshot.snapshotId, JSON.stringify(fingerprint), forkAppId],
      );
      logger.info(
        { jobId, forkAppId, baseReleaseId: job.target_release_id },
        '[update] lineage base advanced',
      );

      await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: new Date() });
      logger.info({ jobId, forkAppId }, '[update] completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Same retry contract as executeClone: only mark the job failed once the
      // task queue has exhausted its attempts, otherwise the terminal-status
      // guard above would short-circuit every retry.
      const isPermanent = task.attempts >= task.max_attempts;
      if (isPermanent) {
        await setCloneJobStatus(controlDb, jobId, {
          status: 'failed', error_message: msg, completed_at: new Date(),
        }).catch(() => {});
      } else {
        await setCloneJobStatus(controlDb, jobId, { error_message: msg }).catch(() => {});
        logger.warn(
          { jobId, attempt: task.attempts, maxAttempts: task.max_attempts, error: msg },
          '[update] transient failure, will retry',
        );
      }
      throw err;
    }
  });
}
