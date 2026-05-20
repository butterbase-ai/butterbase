import pg from 'pg';
import { config, assertRegionConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import * as neonClient from './neon-client.js';
import { getDataProjectIdForRegion } from './neon-projects.js';
import { runMigrationsWithRetry } from './provisioner.js';
import { runDataPlaneMigrations } from './migrator.js';
import { notifyProvisioningFailed } from './failure-notifications.service.js';
import { removeUserAppIndex } from './user-app-index.js';

interface NeonTask {
  id: number;
  app_id: string;
  task_type: 'provision' | 'deprovision';
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_at: Date | null;
  run_after: Date;
  created_at: Date;
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
    } else {
      await executeDeprovision(controlDb, dataPlaneDb, task, logger);
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
