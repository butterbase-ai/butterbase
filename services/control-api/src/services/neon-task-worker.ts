import pg from 'pg';
import * as Sentry from '@sentry/node';
import { config, assertRegionConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import * as neonClient from './neon-client.js';
import { getDataProjectIdForRegion } from './neon-projects.js';
import { runMigrationsWithRetry, generateAppId, insertAppRow, provisionAppBackground } from './provisioner.js';
import { runDataPlaneMigrations } from './migrator.js';
import { notifyProvisioningFailed } from './failure-notifications.service.js';
import { addUserAppIndex, removeUserAppIndex } from './user-app-index.js';
import { getCloneJob, setCloneJobStatus, appendCloneJobWarnings } from './clone-jobs.js';
import {
  getManifestJson,
  putManifest,
  setLatest,
  copyBlobSameRegion,
  copyBlobCrossRegion,
  copyManifestSameRegion,
} from './repo-storage.js';
import { S3Client } from '@aws-sdk/client-s3';
import { getAppPoolForApp } from './app-pool.js';
import { replaySchema, replayRls, replaySeedData, replayFunctions, replayNonSecretConfig, replayAuthHookBinding } from './clone-replay.js';
import { insertCloneAuditLog } from './audit/audit-events-service.js';

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
      await executeClone(controlDb, dataPlaneDb, task, logger);
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
    const neonDbName = `db_${appId}`;
    const owner = config.neon.databaseOwner;

    // Resolve which Neon data project to use based on the app's region
    const appRegionRow = await runtimePool.query<{ region: string }>(
      `SELECT region FROM apps WHERE id = $1`,
      [appId],
    );
    if (appRegionRow.rows.length === 0) throw new Error(`neon-task-worker: app ${appId} not found`);
    const appRegion = appRegionRow.rows[0].region;
    const dataProjectId = getDataProjectIdForRegion(appRegion);

    // Serialize mutating Neon API calls
    await neonClient.withNeonProjectLock(dataProjectId, async () => {
      await neonClient.ensureRoleExists(dataProjectId, owner);
      try {
        await neonClient.createDatabase(dataProjectId, neonDbName, owner);
      } catch (err) {
        // Idempotency: if DB already exists (crashed previous attempt), continue
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('already exists')) {
          logger.info({ appId, neonDbName }, '[neon-task-worker] Database already exists, continuing');
        } else {
          throw err;
        }
      }
    });

    const { connectionUri, poolerHost, pooledConnectionUri } =
      await neonClient.getConnectionString(dataProjectId, neonDbName, owner);

    await neonClient.grantSchemaPrivileges(dataProjectId, neonDbName, owner);

    let poolerConnectionString: string | null = null;
    if (pooledConnectionUri) {
      poolerConnectionString = pooledConnectionUri;
    } else if (poolerHost) {
      const url = new URL(connectionUri);
      url.hostname = poolerHost;
      url.port = '6543';
      poolerConnectionString = url.toString();
    }

    // app_db_connections is a runtime-tier table
    await runtimePool.query(
      `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id) DO NOTHING`,
      [appId, connectionUri, poolerConnectionString, dataProjectId, neonDbName],
    );

    await runMigrationsWithRetry(connectionUri);
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
  // user_app_index, but the delete route already removed that entry
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
      try {
        await neonClient.withNeonProjectLock(neon_project_id, () =>
          neonClient.deleteDatabase(neon_project_id, neon_database_name),
        );
      } catch (err) {
        // Idempotency: if DB is already gone (404), treat as success
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('404') || msg.includes('not found')) {
          logger.info({ appId, neon_database_name }, '[neon-task-worker] Database already deleted, continuing');
        } else {
          throw err;
        }
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

  // Safety-net: remove from user_app_index (idempotent — no-op if already removed by the DELETE route)
  await removeUserAppIndex(controlDb, appId).catch((err) =>
    console.warn('[neon-task-worker] user_app_index remove failed', { err, appId }),
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
  // through user_app_index, which provisionAppBackground populates only after
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
  if (job.status !== 'pending' && job.status !== 'processing') {
    logger.info({ jobId, status: job.status }, '[clone] job in terminal status; skipping');
    return;
  }

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

    try {
      scope.setTag('step', 'provisioning');

      // 1. Provision a fresh dest app via the existing path (mirrors init.ts:196-244).
      //    On retry, job.dest_app_id is already set from the prior attempt — reuse it
      //    and skip provision entirely to avoid creating a second orphaned app row +
      //    Neon database.
      if (job.dest_app_id) {
        // Resume from a prior in-flight attempt: dest app already exists.
        destAppId = job.dest_app_id;
        logger.info({ jobId, destAppId }, '[clone] resuming from prior attempt; skipping provision');
      } else {
        destAppId = generateAppId();
        const destName = job.dest_app_name ?? `Clone of ${job.source_app_id}`;
        await insertAppRow(job.dest_region, controlDb, destName, job.requested_by_user_id, destAppId);
        await setCloneJobStatus(controlDb, jobId, { dest_app_id: destAppId });

        // Cross-region index so authorizeRepoRead/Write and other lookups can
        // resolve the dest app's region. Init route does the same step after
        // its insertAppRow; the clone worker is the equivalent caller here.
        await addUserAppIndex(controlDb, {
          userId: job.requested_by_user_id,
          appId: destAppId,
          region: job.dest_region,
          appName: destName,
        }).catch((err) => {
          logger.warn({ err, destAppId }, '[clone] user_app_index add failed; backfill will repair');
        });

        // Record template lineage on the dest app row (column added by Phase 1 migration).
        //    insertAppRow has no template_source_app_id parameter today — write it via
        //    a follow-up UPDATE on the dest's home runtime DB.
        //    template_source_region (added by B2 migration) lets the delete handler know
        //    which region pool to target without a fan-out lookup.
        const destRuntimePool = getRuntimeDbPool(config.runtimeDb, job.dest_region);
        await destRuntimePool.query(
          `UPDATE apps
              SET template_source_app_id = $1,
                  template_source_region  = $2,
                  updated_at              = now()
            WHERE id = $3`,
          [job.source_app_id, job.source_region, destAppId],
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

      // Step 5 (Phase 5 A4): Replay app_functions from source runtime DB to dest runtime DB.
      scope.setTag('step', 'replaying_functions');
      await setCloneJobStatus(controlDb, jobId, { status: 'replaying_functions' });
      const fnResult = await replayFunctions(
        sourceRuntimePool,
        destRuntimePool,
        job.source_app_id,
        resolvedDestAppId,
        job.requested_by_user_id,
        logger,
      );
      if (fnResult.warnings.length > 0) {
        await appendCloneJobWarnings(controlDb, jobId, fnResult.warnings);
      }
      logger.info(
        { destAppId: resolvedDestAppId, count: fnResult.count, warnings: fnResult.warnings.length },
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

      // 6. Mark job completed.
      await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: new Date() });

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
      // Best-effort failure marker; swallow secondary errors so we still rethrow the original.
      await setCloneJobStatus(controlDb, jobId, { status: 'failed', error_message: msg }).catch(() => {});

      // Emit failed audit event on source app. Wrap in catch so we don't compound the original error.
      await insertCloneAuditLog(controlDb, {
        appId: job.source_app_id,
        userId: job.requested_by_user_id,
        eventType: 'template_clone_failed',
        metadata: { job_id: jobId, dest_app_id: destAppId ?? null, dest_region: job.dest_region, error: msg },
      }).catch((auditErr) => logger.error({ auditErr }, '[clone] audit log failed event insert failed'));

      throw err; // re-throw so the neon-task queue applies its retry/fail logic
    }
  });
}
