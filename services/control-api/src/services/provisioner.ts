import pg from 'pg';
import { customAlphabet } from 'nanoid';
import { config, assertRegionConfig, assertRuntimeDbConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { runDataPlaneMigrations } from './migrator.js';
import * as neonClient from './neon-client.js';
import { getDataProjectIdForRegion } from './neon-projects.js';
import {
  APP_ID_PREFIX,
  APP_ID_LENGTH,
  APP_ID_ALPHABET,
} from '@butterbase/shared';
import type { App, InitResponse } from '@butterbase/shared';
import { KvCredentialsService } from './kv-credentials.js';
import { resolveOrganizationId } from './org-resolver.js';

const generateId = customAlphabet(APP_ID_ALPHABET, APP_ID_LENGTH);

/** Generate a new app ID. Exported so callers can create the ID before calling provisionApp(). */
export function generateAppId(): string {
  return `${APP_ID_PREFIX}${generateId()}`;
}

/**
 * Retries runDataPlaneMigrations with exponential backoff for transient errors that occur while
 * Neon is waking up a cold compute or finishing async DB creation:
 *   - 3D000: database does not exist yet (async create still in progress)
 *   - ECONNREFUSED / ECONNRESET / ETIMEDOUT: compute not ready
 *   - 08006 / 08001: connection failure / inability to establish connection
 *   - 57P01: admin shutdown (compute restarting)
 */
const RETRYABLE_MIGRATION_CODES = new Set([
  '3D000', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '08006', '08001', '57P01',
]);

export async function runMigrationsWithRetry(connectionString: string, maxAttempts = 8): Promise<void> {
  const backoffMs = [500, 1000, 2000, 4000, 8000, 16000, 32000];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runDataPlaneMigrations(connectionString);
      return;
    } catch (err: unknown) {
      const code =
        err instanceof Error && 'code' in err ? (err as { code: string }).code : undefined;
      if (code && RETRYABLE_MIGRATION_CODES.has(code) && attempt < maxAttempts) {
        const delay = backoffMs[attempt - 1] ?? 32000;
        await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Insert the app row into the runtime DB and atomically register the app
 * in the control-plane (for cross-region lookups and KV credential FK).
 * Returns immediately. If an app with the same name+owner already exists,
 * returns it (idempotency).
 */
export async function insertAppRow(
  region: string,
  controlDb: pg.Pool,
  name: string,
  ownerId: string,
  appId: string,
  targetOrganizationId?: string,
): Promise<{ app: App; isExisting: boolean }> {
  // Write the apps row into the TARGET region's runtime DB (where the app
  // is homed), not the local machine's runtime DB. Previously this used
  // the local instanceRegion, which left rows for cross-region apps in
  // the wrong DB — fly-replay would route to the correct region and the
  // sjc handler then 404'd because its local runtime DB had no row.
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

  const existing = await runtimeDb.query<App>(
    'SELECT * FROM apps WHERE name = $1 AND owner_id = $2',
    [name, ownerId]
  );

  if (existing.rows.length > 0) {
    return { app: existing.rows[0], isExisting: true };
  }

  // Prefer the caller-resolved target org (matches what the route wrote to
  // org_app_index). Falling back to resolveOrganizationId(ownerId) here —
  // the pre-orgs path — silently placed team-org apps in the owner's
  // personal org on the runtime side while org_app_index correctly pointed
  // at the team org. The mismatch made those apps invisible in the
  // dashboard's org-scoped list (which filters by apps.organization_id).
  const organizationId = targetOrganizationId
    ?? await resolveOrganizationId(controlDb, ownerId);

  const dbName = appId;
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, organization_id, db_name, db_provisioned, provisioning_status, region, deployment_backend)
     VALUES ($1, $2, $3, $4, $5, false, 'provisioning', $6, $7)`,
    [appId, name, ownerId, organizationId, dbName, region, config.deployment.defaultBackend]
  );

  // Provision KV credentials on the control-plane. The control-plane apps row
  // (Phase 1 cutover) no longer exists; app_kv_credentials has no FK to it.
  // Authoritative app row is the runtime DB INSERT above; cross-region projection
  // is org_app_index, written by the init route after this helper returns.
  const client = await controlDb.connect();
  try {
    await client.query('BEGIN');
    const kvSvc = new KvCredentialsService(client);
    await kvSvc.provision(appId, region);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Roll back the runtime DB insert as well to keep both DBs consistent
    await runtimeDb.query('DELETE FROM apps WHERE id = $1', [appId]).catch((deleteErr) => {
      // Compensating DELETE failed after a control-plane transaction rollback. The runtimeDb apps row is now orphaned.
      // The orphan-cleanup service will not pick this up because org_app_index is written after insertAppRow returns.
      console.error({ err: deleteErr, appId }, '[insertAppRow] compensating runtimeDb DELETE failed; row may be orphaned');
    });
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await runtimeDb.query<App>('SELECT * FROM apps WHERE id = $1', [appId]);
  return { app: rows[0], isExisting: false };
}

/**
 * Background provisioning: Neon DB creation + migrations.
 * Updates provisioning_status to 'ready' on success, 'failed' on error.
 */
export async function provisionAppBackground(
  region: string,
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  appId: string,
): Promise<void> {
  // Write the apps row + app_db_connections in the app's home (target)
  // region, NOT the local machine's region.
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

  try {
    if (config.neon.enabled) {
      const dataProjectId = getDataProjectIdForRegion(region);
      const neonDbName = `db_${appId}`;
      const owner = config.neon.databaseOwner;

      // Serialize mutating Neon API calls; read-only getConnectionString runs outside the lock.
      await neonClient.withNeonProjectLock(dataProjectId, async () => {
        await neonClient.ensureRoleExists(dataProjectId, owner);
        await neonClient.createDatabase(dataProjectId, neonDbName, owner);
      });

      const { connectionUri, poolerHost, pooledConnectionUri } =
        await neonClient.getConnectionString(dataProjectId, neonDbName, owner);

      // PG 15+ revokes CREATE on public schema by default; grant it to the app role
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

      await runtimeDb.query(
        `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app_id) DO NOTHING`,
        [appId, connectionUri, poolerConnectionString, dataProjectId, neonDbName]
      );

      await runMigrationsWithRetry(connectionUri);
    } else {
      const client = await dataPlaneDb.connect();
      try {
        await client.query(`CREATE DATABASE "${appId}" OWNER ${config.dataPlaneDb.user}`);
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '42P04') {
          // already exists
        } else {
          throw err;
        }
      } finally {
        client.release();
      }

      await runDataPlaneMigrations(appId);

      const localConnectionString = `postgresql://${config.dataPlaneDb.user}:${config.dataPlaneDb.password}@${config.pgbouncer.host}:${config.pgbouncer.port}/${appId}`;
      await runtimeDb.query(
        `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
         VALUES ($1, $2, NULL, NULL, NULL)
         ON CONFLICT (app_id) DO NOTHING`,
        [appId, localConnectionString]
      );
    }

    await runtimeDb.query(
      `UPDATE apps SET db_provisioned = true, provisioning_status = 'ready', updated_at = now() WHERE id = $1`,
      [appId]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[provisioner] Background provisioning failed for ${appId}:`, msg);
    
    // Sanitize any underlying infrastructure errors to avoid leaking internal architecture
    const genericError = msg.includes('Neon API error') || msg.includes('NeonDb') || msg.includes('neon_')
      ? 'Database failed to provision due to an internal infrastructure error.'
      : msg.slice(0, 1000);

    await runtimeDb.query(
      `UPDATE apps SET provisioning_status = 'failed', provisioning_error = $2, updated_at = now() WHERE id = $1`,
      [appId, genericError]
    ).catch(() => {});
    // Don't notify here — the queue worker (neon-task-worker.ts) owns failure notification
    // and only fires after attempts >= max_attempts. Notifying inline on every transient
    // failure produces false-alarm emails when the clone/provision task retries successfully.
  }
}

export async function provisionApp(
  region: string,
  controlDb: pg.Pool,
  dataPlaneDb: pg.Pool,
  name: string,
  ownerId: string,
  appId: string
): Promise<InitResponse> {
  // apps row lives in the target region's runtime DB, not the local machine's.
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

  // Check for existing app with same name + owner (idempotency)
  const existing = await runtimeDb.query<App>(
    'SELECT * FROM apps WHERE name = $1 AND owner_id = $2',
    [name, ownerId]
  );

  if (existing.rows.length > 0) {
    const app = existing.rows[0];

    // If previously failed provisioning, retry migrations
    if (!app.db_provisioned) {
      if (config.neon.enabled) {
        const connRow = await runtimeDb.query<{ connection_string: string }>(
          'SELECT connection_string FROM app_db_connections WHERE app_id = $1',
          [app.id]
        );
        if (connRow.rows.length > 0) {
          await runMigrationsWithRetry(connRow.rows[0].connection_string);
        }
      } else {
        await runDataPlaneMigrations(app.db_name);
      }
      await runtimeDb.query(
        'UPDATE apps SET db_provisioned = true, updated_at = now() WHERE id = $1',
        [app.id]
      );
    }

    return formatResponse(app, runtimeDb);
  }

  // Validate owner exists and resolve their org (platform-tier, stays on controlDb)
  const organizationId = await resolveOrganizationId(controlDb, ownerId);

  const dbName = appId;

  // Insert app record with db_provisioned = false
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, organization_id, db_name, db_provisioned, region, deployment_backend)
     VALUES ($1, $2, $3, $4, $5, false, $6, $7)`,
    [appId, name, ownerId, organizationId, dbName, region, config.deployment.defaultBackend]
  );

  if (config.neon.enabled) {
    const dataProjectId = getDataProjectIdForRegion(region);
    const neonDbName = `db_${appId}`;
    const owner = config.neon.databaseOwner;

    // Serialize Neon API calls — only one create/delete runs at a time per project
    const { connectionUri, poolerHost, pooledConnectionUri } =
      await neonClient.withNeonProjectLock(dataProjectId, async () => {
        await neonClient.ensureRoleExists(dataProjectId, owner);
        await neonClient.createDatabase(dataProjectId, neonDbName, owner);
        return neonClient.getConnectionString(dataProjectId, neonDbName, owner);
      });

    // PG 15+ revokes CREATE on public schema by default; grant it to the app role
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

    // Store connection info
    await runtimeDb.query(
      `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [appId, connectionUri, poolerConnectionString, dataProjectId, neonDbName]
    );

    // Run data-plane migrations via Neon connection string (with retry for async DB readiness)
    await runMigrationsWithRetry(connectionUri);
  } else {
    // Local dev: CREATE DATABASE on local data-plane
    const client = await dataPlaneDb.connect();
    try {
      await client.query(`CREATE DATABASE "${dbName}" OWNER ${config.dataPlaneDb.user}`);
    } catch (err: unknown) {
      // 42P04 = database already exists — treat as success
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '42P04') {
        // Database exists, continue to migrations
      } else {
        throw err;
      }
    } finally {
      client.release();
    }

    await runDataPlaneMigrations(dbName);

    // Insert connection string record for local dev (similar to production)
    const localConnectionString = `postgresql://${config.dataPlaneDb.user}:${config.dataPlaneDb.password}@${config.pgbouncer.host}:${config.pgbouncer.port}/${dbName}`;

    await runtimeDb.query(
      `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
       VALUES ($1, $2, NULL, NULL, NULL)
       ON CONFLICT (app_id) DO NOTHING`,
      [appId, localConnectionString]
    );
  }

  // Mark as provisioned
  await runtimeDb.query(
    'UPDATE apps SET db_provisioned = true, updated_at = now() WHERE id = $1',
    [appId]
  );

  const { rows } = await runtimeDb.query<App>(
    'SELECT * FROM apps WHERE id = $1',
    [appId]
  );

  return formatResponse(rows[0], runtimeDb);
}

/**
 * Masks password in connection string for security
 */
function maskConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    // If URL parsing fails, return as-is
    return connectionString;
  }
}

async function formatResponse(app: App, runtimeDb: pg.Pool): Promise<InitResponse> {
  if (config.neon.enabled) {
    const connRow = await runtimeDb.query<{
      connection_string: string;
      pooler_connection_string: string | null;
      neon_database_name: string;
    }>(
      'SELECT connection_string, pooler_connection_string, neon_database_name FROM app_db_connections WHERE app_id = $1',
      [app.id]
    );

    if (connRow.rows.length > 0) {
      const conn = connRow.rows[0];
      const url = new URL(conn.connection_string);
      return {
        app_id: app.id,
        name: app.name,
        database: {
          host: url.hostname,
          port: parseInt(url.port || '5432', 10),
          name: conn.neon_database_name,
          user: url.username,
          connection_string: maskConnectionString(conn.pooler_connection_string ?? conn.connection_string),
        },
        api_url: `${config.apiBaseUrl}/v1/${app.id}`,
        created_at: app.created_at.toISOString(),
        _meta: {
          next_actions: [
            { action: 'apply_schema', description: 'Define your database tables and columns', recommended: true },
            { action: 'configure_oauth_provider', description: 'Set up user authentication with OAuth', recommended: true },
            { action: 'update_cors', description: 'Configure allowed frontend origins for browser requests', recommended: false },
          ],
        },
      };
    }
  }

  return {
    app_id: app.id,
    name: app.name,
    database: {
      host: config.pgbouncer.host,
      port: config.pgbouncer.port,
      name: app.db_name,
      user: config.dataPlaneDb.user,
      connection_string: `postgresql://${config.dataPlaneDb.user}:***@${config.pgbouncer.host}:${config.pgbouncer.port}/${app.db_name}`,
    },
    api_url: `${config.apiBaseUrl}/v1/${app.id}`,
    created_at: app.created_at.toISOString(),
    _meta: {
      next_actions: [
        { action: 'apply_schema', description: 'Define your database tables and columns', recommended: true },
        { action: 'configure_oauth_provider', description: 'Set up user authentication with OAuth', recommended: true },
        { action: 'update_cors', description: 'Configure allowed frontend origins for browser requests', recommended: false },
      ],
    },
  };
}

/**
 * Phase 5 / E2E: create the customer DB in the region's data plane and return
 * the connection URI. Does NOT write app_db_connections or run customer
 * migrations — the move-app saga's reserving_dest step does that separately.
 *
 * Idempotent: returns the same name + URI on re-run; CREATE DATABASE is
 * guarded by an existence check.
 */
export async function provisionAppDb(
  region: string,
  appId: string,
  _ownerId: string,
): Promise<{ neonDbName: string; connectionUri: string }> {
  // provisionAppDb runs in both control-api (where the fastify plugin
  // already asserted) and cron-scheduler (which never registers the
  // plugin). Idempotent guard handles the first case.
  assertRuntimeDbConfig();

  // NEON_DATA_PROJECT_ID_<REGION> holds a Neon project ID (e.g.
  // "silent-cake-48449293"), NOT a postgres connection string. Use the
  // Neon Management API to create the database, mirroring the pattern
  // used by neon-task-worker.executeProvision.
  const dataProjectId = getDataProjectIdForRegion(region);
  if (!dataProjectId) throw new Error(`No data project for region ${region}`);

  const owner = config.neon.databaseOwner;
  // Postgres datname max length = 63 bytes
  const neonDbName = `cust_${appId.replace(/-/g, '_')}_${region.replace(/-/g, '_')}`
    .toLowerCase()
    .slice(0, 63);

  // Serialize Neon API calls per project; idempotent on "already exists".
  await neonClient.withNeonProjectLock(dataProjectId, async () => {
    await neonClient.ensureRoleExists(dataProjectId, owner);
    try {
      await neonClient.createDatabase(dataProjectId, neonDbName, owner);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('already exists')) throw err;
    }
  });
  await neonClient.grantSchemaPrivileges(dataProjectId, neonDbName, owner);

  const { connectionUri, poolerHost, pooledConnectionUri } = await neonClient.getConnectionString(
    dataProjectId, neonDbName, owner,
  );

  // step-restore-data reads app_db_connections in the dest region to find the
  // restore target. Persist the row now so the saga's next step (restoring_data)
  // can resolve it. Mirrors neon-task-worker.executeProvision.
  let poolerConnectionString: string | null = null;
  if (pooledConnectionUri) {
    poolerConnectionString = pooledConnectionUri;
  } else if (poolerHost) {
    const url = new URL(connectionUri);
    url.hostname = poolerHost;
    url.port = '6543';
    poolerConnectionString = url.toString();
  }
  const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
  await runtimePool.query(
    `INSERT INTO app_db_connections (app_id, connection_string, pooler_connection_string, neon_project_id, neon_database_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id) DO UPDATE
       SET connection_string = EXCLUDED.connection_string,
           pooler_connection_string = EXCLUDED.pooler_connection_string,
           neon_project_id = EXCLUDED.neon_project_id,
           neon_database_name = EXCLUDED.neon_database_name`,
    [appId, connectionUri, poolerConnectionString, dataProjectId, neonDbName],
  );

  return { neonDbName, connectionUri };
}
